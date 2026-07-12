import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { shopifyConnector } from './connectors/shopify';
import { alegraConnector } from './connectors/alegra';
import { auditService } from '../services/audit';
import { sseService } from '../services/sse';
import { env } from '../config/env';
import { getAlegraIds } from '../services/alegraBootstrap';
import { AlegraItemCreatePayload, SyncCycleResult, ShopifyProduct } from '../types';
import { buildIdempotencyKey } from '../utils/idempotency';
import { mapWithConcurrency } from '../utils/concurrency';
import { KeyedMutex } from '../utils/keyedMutex';

class OrchestratorCore {
  private isSyncing   = false;
  private isInCatchup = false;

  get syncingStatus() {
    return { isSyncing: this.isSyncing, isInCatchup: this.isInCatchup };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  CICLO DE POLLING PRINCIPAL (cada 10 segundos)
  // ═══════════════════════════════════════════════════════════════════════════
  async runPollingCycle(): Promise<SyncCycleResult> {
    if (this.isSyncing) {
      logger.debug('Ciclo omitido — ya hay uno en curso');
      return { skusChecked: 0, deltasApplied: 0, errors: [], durationMs: 0 };
    }

    this.isSyncing = true;
    const start = Date.now();
    const result: SyncCycleResult = {
      skusChecked:   0,
      deltasApplied: 0,
      errors:        [],
      durationMs:    0,
    };

    try {
      await prisma.syncState.update({
        where: { id: 1 },
        data:  { status: 'syncing', lastAttemptedSync: new Date() },
      });

      // ── Verificar si necesitamos catchup ──────────────────────────────────
      const syncState = await prisma.syncState.findUnique({ where: { id: 1 } });
      if (syncState?.lastSuccessfulSync) {
        const gapMs  = Date.now() - syncState.lastSuccessfulSync.getTime();
        const gapMin = gapMs / 60000;

        if (gapMin > env.CATCHUP_THRESHOLD_MINUTES) {
          logger.warn(`Gap de ${gapMin.toFixed(1)} min detectado — iniciando catchup sync`);
          await this.runCatchupSync(syncState.lastSuccessfulSync, gapMin);
          // El catchup ya actualizó sync_state — salir del ciclo normal
          return result;
        }
      }

      // ── Detectar productos nuevos en Shopify no registrados en catalog ────
      // El webhook products/create es el canal principal, pero puede fallar.
      // Esta verificación actúa como red de seguridad: cada N ciclos compara
      // todos los SKUs de Shopify contra product_catalog y crea los faltantes.
      // Usa el mismo patrón del v4: requiere verlo 2 ciclos seguidos antes de
      // actuar (evita crear por variantes temporalmente sin stock o incompletas).
      try {
        await this.detectNewShopifyProducts();
      } catch (err) {
        const msg = `Error en detección de productos nuevos: ${(err as Error).message}`;
        logger.warn(msg);
        result.errors.push(msg);
        // No abortar — continuar con el ciclo de reconciliación normal
      }

      // ── Detectar productos creados directamente en Alegra (fuera de Shopify) ──
      // Solo informativo — no crea ni actualiza inventario, ver detectAlegraOrphanProducts.
      // Corre cada ORPHAN_CHECK_EVERY_N_CYCLES ciclos (no en cada uno) porque
      // trae el listado completo de ítems de Alegra — es costoso y no urgente.
      this.cycleCount++;
      if (this.cycleCount % this.ORPHAN_CHECK_EVERY_N_CYCLES === 0) {
        try {
          await this.detectAlegraOrphanProducts();
        } catch (err) {
          const msg = `Error en detección de huérfanos de Alegra: ${(err as Error).message}`;
          logger.warn(msg);
          result.errors.push(msg);
        }
      }

      // ── Detectar y reparar registros huérfanos en product_catalog ─────────
      // Si master_inventory fue borrado manualmente, o el ítem en Alegra fue
      // eliminado fuera del middleware, el catalog queda en estado huérfano:
      // el sistema "cree" que el SKU está sincronizado pero una o ambas puntas
      // ya no existen. Esto detecta esos casos y repara recreando lo que falte.
      try {
        const orphanReport = await this.reconcileOrphans();
        if (orphanReport.repaired > 0 || orphanReport.errors.length > 0) {
          logger.info(
              `Orphan reconcile: ${orphanReport.repaired} reparado(s), ` +
              `${orphanReport.errors.length} error(es)`,
          );
          result.errors.push(...orphanReport.errors);
        }
      } catch (err) {
        const msg = `Error en reconciliación de huérfanos: ${(err as Error).message}`;
        logger.warn(msg);
        result.errors.push(msg);
      }

      // ── Obtener todos los SKUs sincronizados activos ───────────────────────
      const catalog = await prisma.productCatalog.findMany({
        where:   { status: 'active' },
        include: { inventory: true },
      });

      result.skusChecked = catalog.length;

      // ── Procesar cada SKU (hasta RECONCILE_CONCURRENCY en paralelo) ────────
      await mapWithConcurrency(catalog, this.RECONCILE_CONCURRENCY, async (entry: typeof catalog[number]) => {
        try {
          const changed = await this.reconcileSku(entry);
          // deltasApplied cuenta solo los SKUs donde realmente se aplicó un cambio
          if (changed) result.deltasApplied++;
        } catch (err) {
          const status = (err as { response?: { status?: number } }).response?.status;

          // ── Auto-reparación: la variante ya no existe en Shopify ────────────
          // Esto pasa cuando el webhook products/delete no llegó (Shopify no
          // reintenta indefinidamente, o el evento se perdió por caída del
          // servicio). Sin esto, el ciclo repetiría este mismo error 404 para
          // siempre — en vez de eso, archivamos automáticamente, igual que
          // hace handleProductDelete cuando el webhook sí llega.
          if (status === 404) {
            try {
              await this.archiveVariant(entry.shopifyVariantId, `reconcile_404_self_heal_sku_${entry.sku}`);
              logger.warn(
                  `SKU ${entry.sku}: variante no encontrada en Shopify (404) — ` +
                  `archivada automáticamente (probable webhook products/delete perdido).`,
              );
              return; // no la contamos como error del ciclo, ya se auto-reparó
            } catch (archiveErr) {
              const archiveMsg =
                  `Error auto-archivando SKU ${entry.sku} tras 404: ${(archiveErr as Error).message}`;
              logger.error(archiveMsg);
              result.errors.push(archiveMsg);
              return;
            }
          }

          const msg = `Error reconciliando SKU ${entry.sku}: ${(err as Error).message}`;
          logger.error(msg);
          result.errors.push(msg);
        }
      });

      // ── Marcar ciclo exitoso ───────────────────────────────────────────────
      await prisma.syncState.update({
        where: { id: 1 },
        data:  {
          status:              'idle',
          lastSuccessfulSync:  new Date(),
          consecutiveFailures: 0,
          errorDetail:         null,
        },
      });

    } catch (err) {
      logger.error('Error en ciclo de polling principal:', err);
      result.errors.push((err as Error).message);
      await prisma.syncState.update({
        where: { id: 1 },
        data:  {
          status:      'error',
          errorDetail: (err as Error).message,
          consecutiveFailures: { increment: 1 },
        },
      });
    } finally {
      this.isSyncing   = false;
      result.durationMs = Date.now() - start;
    }

    sseService.emitSyncTick(result.skusChecked, result.deltasApplied, 'idle');
    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  RECONCILIACIÓN DE UN SKU
  //  RF-03: resolución de conflictos por ventas simultáneas.
  //  Retorna true si se aplicó algún cambio (stock, precio o costo).
  // ═══════════════════════════════════════════════════════════════════════════
  private skuMutex = new KeyedMutex();

  // Wrapper: adquiere el candado por SKU antes de delegar en la lógica real.
  // Esto protege contra la condición de carrera donde dos procesos distintos
  // (ej. el webhook de Shopify vía forceSyncSku, y el ciclo lento) intentan
  // reconciliar el MISMO SKU casi al mismo tiempo — sin esto, el que escribe
  // último puede sobrescribir silenciosamente la corrección del otro con una
  // lectura desactualizada.
  private async reconcileSku(entry: {
    sku:              string;
    shopifyVariantId: string;
    alegraItemId:     string;
    shopifyInventoryItemId?: string | null;
    lastKnownPrice:   { toNumber(): number };
    lastKnownCost:    { toNumber(): number };
    inventory: {
      stockGlobal:      number;
      stockAlegraLast:  number;
      stockShopifyLast: number;
    } | null;
  }): Promise<boolean> {
    return this.skuMutex.runExclusive(entry.sku, () => this.reconcileSkuInternal(entry));
  }

  private async reconcileSkuInternal(entry: {
    sku:              string;
    shopifyVariantId: string;
    alegraItemId:     string;
    shopifyInventoryItemId?: string | null;
    lastKnownPrice:   { toNumber(): number };
    lastKnownCost:    { toNumber(): number };
    inventory: {
      stockGlobal:      number;
      stockAlegraLast:  number;
      stockShopifyLast: number;
    } | null;
  }): Promise<boolean> {
    if (!entry.inventory) return false;

    const { sku, shopifyVariantId, alegraItemId } = entry;
    const master = entry.inventory;
    let anyChange = false;

    // ── 1. Obtener stock actual en ambas plataformas ───────────────────────
    // getVariant devuelve inventory_item_id e inventory_management en una sola llamada
    const variantData            = await shopifyConnector.getVariant(shopifyVariantId);
    const shopifyInventoryItemId = variantData.inventory_item_id;
    const shopifyTracking        = variantData.inventory_management; // null = sin tracking
    const currentShopify         = await shopifyConnector.getInventoryLevel(shopifyInventoryItemId);
    const alegraItem     = await alegraConnector.getItem(alegraItemId);
    const currentAlegra  = alegraItem.inventory?.warehouses?.[0]?.availableQuantity ?? 0;

    // ── Backfill: registros creados antes de shopifyInventoryItemId existir ──
    // Se autocompleta la primera vez que este SKU pasa por reconciliación,
    // así el webhook inventory_levels/update puede encontrarlo sin esperar
    // a que todo el catálogo se vuelva a crear desde cero.
    if (!entry.shopifyInventoryItemId) {
      prisma.productCatalog.update({
        where: { sku },
        data:  { shopifyInventoryItemId: String(shopifyInventoryItemId) },
      }).catch((err: Error) => logger.warn(`Backfill shopifyInventoryItemId falló para SKU ${sku}: ${err.message}`));
    }

    // ── 2. Calcular deltas REALES (no snapshot comparison) ────────────────
    // RF-03: si ambas plataformas vendieron, capturamos ambos deltas independientemente.
    //
    // IMPORTANTE: si inventory_management !== 'shopify', Shopify no controla el stock
    // de esta variante y getInventoryLevel devuelve 0 siempre — lo que generaría un
    // falso delta igual al stockShopifyLast en cada ciclo. En ese caso ignoramos el
    // delta de Shopify y solo procesamos el de Alegra.
    const deltaShopify = shopifyTracking === 'shopify'
        ? master.stockShopifyLast - currentShopify
        : 0; // sin tracking → sin delta real en Shopify
    const deltaAlegra  = master.stockAlegraLast  - currentAlegra;
    const hasStockChange = deltaShopify !== 0 || deltaAlegra !== 0;

    if (hasStockChange) {
      // ── 3. Calcular nuevo stock global ──────────────────────────────────
      const newGlobal = Math.max(0, master.stockGlobal - deltaShopify - deltaAlegra);
      const oldGlobal = master.stockGlobal;

      logger.info(
          `Reconciliando ${sku}: master=${oldGlobal}, ` +
          `Δshopify=${deltaShopify}, Δalegra=${deltaAlegra} → nuevo=${newGlobal}`,
      );

      // ── 4. Actualizar master_inventory ──────────────────────────────────
      await prisma.masterInventory.update({
        where: { sku },
        data:  {
          stockGlobal:      newGlobal,
          // Solo actualizar stockShopifyLast si hay tracking real.
          // Sin tracking, Shopify siempre reporta 0 → no actualizar _last para
          // evitar que el siguiente ciclo calcule un falso delta de tamaño newGlobal.
          stockShopifyLast: shopifyTracking === 'shopify' ? newGlobal : master.stockShopifyLast,
          stockAlegraLast:  newGlobal,
          lastUpdated:      new Date(),
          lastUpdatedBy:    'orchestrator',
        },
      });

      // ── 5. Propagar a ambas plataformas ──────────────────────────────────
      const sourceRef = `poll_${Date.now()}_${sku}`;

      // Solo actualizar stock en Shopify si la variante tiene tracking activado.
      // inventory_management = null significa que Shopify no controla el inventario
      // de esta variante — setInventoryLevel devuelve 422 en ese caso.
      if (shopifyTracking === 'shopify') {
        await shopifyConnector.setInventoryLevel(shopifyInventoryItemId, newGlobal);
      } else {
        logger.debug(
            `SKU ${sku}: omitiendo setInventoryLevel en Shopify ` +
            `(inventory_management="${shopifyTracking ?? 'null'}"). ` +
            `Activa "Track quantity" en Shopify para sincronizar stock bidireccional.`,
        );
      }

      const adjustQty = newGlobal - currentAlegra;
      if (adjustQty !== 0) {
        await alegraConnector.adjustStock(
            alegraItemId,
            adjustQty,
            `Sync Bagatta Middleware — Δshopify:${deltaShopify} Δalegra:${deltaAlegra}`,
            entry.lastKnownCost.toNumber(),  // preservar costo promedio en Alegra
        );
      }

      // ── 6. Audit log stock ────────────────────────────────────────────────
      await auditService.logStockChange({
        sku,
        oldStock:       oldGlobal,
        newStock:       newGlobal,
        origin:         'orchestrator',
        sourceEventRef: sourceRef,
      });

      if (deltaShopify > 0 || deltaAlegra > 0) {
        sseService.emitConflictResolved(sku, oldGlobal, newGlobal, deltaShopify, deltaAlegra);
      }

      anyChange = true;
    }

    // ── 7. Reconciliar precio y costo (independiente del stock) ──────────
    const priceOrCostChanged = await this.reconcilePriceAndCost(entry, alegraItem);
    if (priceOrCostChanged) anyChange = true;

    return anyChange;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  RECONCILIACIÓN DE PRECIO Y COSTO
  //  Shopify es master para ambos. Si Alegra difiere → revertir a Shopify.
  //  Retorna true si se aplicó algún cambio.
  // ═══════════════════════════════════════════════════════════════════════════
  private async reconcilePriceAndCost(
      entry: {
        sku:              string;
        shopifyVariantId: string;
        alegraItemId:     string;
        lastKnownPrice:   { toNumber(): number };
        lastKnownCost:    { toNumber(): number };
      },
      alegraItem: Awaited<ReturnType<typeof alegraConnector.getItem>>,
  ): Promise<boolean> {
    const { sku, alegraItemId } = entry;
    const masterPrice = entry.lastKnownPrice.toNumber();
    const masterCost  = entry.lastKnownCost.toNumber();
    const alegraPrice = alegraItem.price?.[0]?.price ?? 0;
    const alegraCost  = alegraItem.inventory?.unitCost ?? 0;
    let anyChange     = false;

    // ── Precio ───────────────────────────────────────────────────────────────
    // Tolerancia de 1 centavo para evitar falsos positivos por redondeo float
    if (Math.abs(alegraPrice - masterPrice) > 0.01 && masterPrice > 0) {
      const isAlegraOrigin = alegraPrice !== masterPrice;
      logger.warn(
          `SKU ${sku}: precio Alegra (${alegraPrice}) ≠ master Shopify (${masterPrice}). Revirtiendo.`,
      );

      await alegraConnector.updateItemPrice(alegraItemId, masterPrice);

      await auditService.logPriceChange({
        sku,
        oldPrice:       alegraPrice,
        newPrice:       masterPrice,
        origin:         isAlegraOrigin ? 'alegra_polling' : 'orchestrator',
        sourceEventRef: `price_revert_${Date.now()}_${sku}`,
      });

      anyChange = true;
    }

    // ── Costo ────────────────────────────────────────────────────────────────
    // Solo sincronizar si el master tiene un costo válido (>0) y difiere de Alegra
    if (Math.abs(alegraCost - masterCost) > 0.01 && masterCost > 0) {
      logger.info(
          `SKU ${sku}: costo Alegra (${alegraCost}) ≠ master Shopify (${masterCost}). Actualizando.`,
      );

      await alegraConnector.updateItemCost(alegraItemId, masterCost);

      const costKey = buildIdempotencyKey('orchestrator', `cost_sync_${Date.now()}_${sku}`, 'cost');
      await auditService.log({
        idempotencyKey: costKey,
        sku,
        fieldChanged:   'cost',
        oldValue:       String(alegraCost),
        newValue:       String(masterCost),
        origin:         'orchestrator',
        sourceEventRef: `cost_sync_${sku}`,
      });

      anyChange = true;
    }

    return anyChange;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  CATCHUP SYNC (RF-05)
  //  Recuperación tras downtime. Lee desde las APIs externas por rango de fechas.
  // ═══════════════════════════════════════════════════════════════════════════
  async runCatchupSync(since: Date, gapMinutes: number): Promise<void> {
    this.isInCatchup = true;
    const startTs = Date.now();

    sseService.emitCatchupStart(gapMinutes, since);
    logger.warn(`Catchup sync iniciado. Gap: ${gapMinutes.toFixed(1)} min desde ${since.toISOString()}`);

    await prisma.syncState.update({ where: { id: 1 }, data: { status: 'catchup' } });

    try {
      // ── Catchup simplificado: reutiliza fastAlegraSync (lectura en bloque) ──
      //
      // Antes: recorría cada SKU secuencialmente llamando a Shopify 2 veces +
      // Alegra 1 vez por cada uno — con cientos de SKUs esto reventaba el
      // rate limit de Shopify (2 req/s) casi de inmediato, generando una
      // tormenta de 429 que empeoraba mientras más SKUs había.
      //
      // Ahora: el lado de Shopify NO necesita re-verificación manual durante
      // el catchup, porque Shopify reintenta automáticamente los webhooks
      // que no pudo entregar durante el downtime (hasta 48h de reintentos
      // con backoff) — en cuanto el servidor vuelve a estar arriba, esos
      // eventos perdidos llegan solos. Lo único que Alegra no puede avisarnos
      // por sí solo son los cambios hechos ahí directamente durante la caída,
      // y eso es exactamente lo que fastAlegraSync ya resuelve en bloque,
      // sin importar cuántos SKUs tengas.
      const fastResult = await this.fastAlegraSync();
      const skusReconciled = fastResult.changed;

      if (fastResult.errors.length > 0) {
        logger.warn(`Catchup: fastAlegraSync completó con ${fastResult.errors.length} errores`, fastResult.errors);
      }

      // ── 4. Alerta si el downtime fue significativo ─────────────────────────
      if (gapMinutes > env.DOWNTIME_ALERT_THRESHOLD_MINUTES) {
        await auditService.createAlert({
          type:   'downtime',
          detail: `El middleware estuvo inactivo ${gapMinutes.toFixed(1)} min ` +
              `(${since.toISOString()} → ${new Date().toISOString()}). ` +
              `${skusReconciled} SKUs reconciliados.`,
        });
      }

      const durationMs = Date.now() - startTs;
      sseService.emitCatchupEnd(skusReconciled, durationMs);
      logger.info(`Catchup completado: ${skusReconciled} SKUs en ${durationMs}ms`);

      await prisma.syncState.update({
        where: { id: 1 },
        data:  { status: 'idle', lastSuccessfulSync: new Date(), consecutiveFailures: 0 },
      });

    } catch (err) {
      logger.error('Catchup sync error:', err);
      await prisma.syncState.update({
        where: { id: 1 },
        data:  { status: 'error', errorDetail: (err as Error).message },
      });
      throw err;
    } finally {
      this.isInCatchup = false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  DETECCIÓN DE PRODUCTOS NUEVOS EN SHOPIFY (red de seguridad del polling)
  //
  //  El webhook products/create es el canal principal. Este método es la red
  //  de seguridad: compara todos los SKUs activos de Shopify contra
  //  product_catalog y crea los que faltan.
  //
  //  Patrón del contador de confirmación (idéntico al v4):
  //  - Primera vez que se detecta un SKU nuevo → pendingConfirmation[sku] = 1
  //  - Segunda vez consecutiva               → se activa handleProductCreate
  //  - Esto evita crear variantes que Shopify está procesando (estado temporal)
  //
  //  El mapa en memoria se resetea al reiniciar el proceso, lo que es correcto:
  //  el peor caso es esperar 2 ciclos adicionales (20 segundos) tras un restart.
  // ═══════════════════════════════════════════════════════════════════════════
  private pendingNewProducts = new Map<string, { product: ShopifyProduct; count: number }>();

  // Cuántos SKUs se reconcilian en paralelo por ciclo. No poner muy alto:
  // cada SKU en vuelo dispara 3 requests (2 a Shopify, 1 a Alegra) — un
  // valor moderado evita saturar los rate limits de ambas APIs mientras
  // sigue dando una mejora grande frente al procesamiento 100% secuencial.
  // Con el rate limiter de Shopify (2 req/s) ya en su lugar, un valor más
  // bajo aquí evita que muchas promesas se acumulen esperando el mismo token
  // a la vez — el rate limiter ya serializa el acceso real a Shopify, así
  // que la concurrencia solo ayuda a superponer la latencia de red y la
  // llamada (no-competitiva) a Alegra.
  private readonly RECONCILE_CONCURRENCY = 3;

  // Cada cuántos ciclos se corre detectAlegraOrphanProducts. Es puramente
  // informativo (no toca inventario, ver la función para más contexto), así
  // que no necesita correr cada ciclo — reduce el costo fijo por ciclo sin
  // perder la detección, solo la retrasa un poco (aceptable para una alerta
  // informativa, no para reconciliación de stock real).
  private readonly ORPHAN_CHECK_EVERY_N_CYCLES = 5;
  private cycleCount = 0;

  // Refs (SKUs) de ítems de Alegra ya alertados como "huérfanos" — evita
  // spamear la misma alerta cada 10s mientras el producto siga sin vincular.
  private alertedAlegraOrphanRefs = new Set<string>();

  private async detectNewShopifyProducts(): Promise<void> {
    // Traer todos los productos de Shopify de una sola vez
    const shopifyProducts = await shopifyConnector.listProducts();
    if (!shopifyProducts.length) return;

    // Construir Set de variant IDs ya registrados en catalog (lookup O(1))
    const registeredVariantIds = new Set(
        (await prisma.productCatalog.findMany({ select: { shopifyVariantId: true } }))
            .map((r: { shopifyVariantId: string }) => r.shopifyVariantId),
    );

    // Agrupar variantes nuevas por producto
    const newByProductId = new Map<string, ShopifyProduct>();

    for (const product of shopifyProducts) {
      const newVariants = product.variants.filter(
          (v) =>
              // Solo requiere SKU definido y no estar ya en catalog.
              // inventory_management puede ser null en Shopify cuando el tracking
              // no está activado en la location — eso NO impide la creación en Alegra.
              v.sku &&
              v.sku.trim() !== '' &&
              !registeredVariantIds.has(String(v.id)),
      );

      if (newVariants.length === 0) continue;

      const productId = String(product.id);
      newByProductId.set(productId, { ...product, variants: newVariants });
    }

    // Limpiar del mapa productos que ya no tienen variantes nuevas
    for (const productId of this.pendingNewProducts.keys()) {
      if (!newByProductId.has(productId)) {
        this.pendingNewProducts.delete(productId);
      }
    }

    // Procesar cada producto con variantes nuevas
    for (const [productId, product] of newByProductId) {
      const pending = this.pendingNewProducts.get(productId);

      if (!pending) {
        // Primera detección — guardar en mapa, esperar confirmación
        this.pendingNewProducts.set(productId, { product, count: 1 });
        logger.info(
            `[DetectNew] Producto "${product.title}" (id=${productId}) tiene ` +
            `${product.variants.length} variante(s) nueva(s). Esperando confirmación (ciclo 1/2).`,
        );
        continue;
      }

      // Segunda detección consecutiva — confirmar y crear
      pending.count++;
      pending.product = product; // actualizar con datos frescos

      if (pending.count >= 2) {
        logger.info(
            `[DetectNew] Confirmado: creando ${product.variants.length} variante(s) de ` +
            `"${product.title}" (id=${productId}) que no llegaron por webhook.`,
        );

        try {
          await this.handleProductCreate(product);
          // Limpiar del mapa — ya fue procesado
          this.pendingNewProducts.delete(productId);
        } catch (err) {
          logger.error(`[DetectNew] Error creando producto ${productId}:`, err);
          // Mantener en mapa para reintentar en el siguiente ciclo
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  DETECCIÓN DE PRODUCTOS CREADOS DIRECTAMENTE EN ALEGRA (categoría sincronizada)
  //  Shopify es el maestro para creación — un ítem creado a mano en Alegra con
  //  la categoría "Tienda Virtual y Física" queda fuera del catalog y NUNCA
  //  recibirá ajustes de inventario automáticos. Esto es solo informativo:
  //  no crea, no borra, no toca stock. Solo avisa para que se corrija a mano.
  // ═══════════════════════════════════════════════════════════════════════════
  private async detectAlegraOrphanProducts(): Promise<void> {
    // getSyncedItems() ya filtra por la categoría configurada (Tienda Virtual y Física)
    const items = await alegraConnector.getSyncedItems();
    if (!items.length) return;

    const registeredSkus = new Set(
        (await prisma.productCatalog.findMany({ select: { sku: true } }))
            .map((r: { sku: string }) => r.sku),
    );

    const currentOrphanRefs = new Set<string>();

    for (const item of items) {
      const ref = item.reference?.trim();
      if (!ref || registeredSkus.has(ref)) continue;

      currentOrphanRefs.add(ref);
      if (this.alertedAlegraOrphanRefs.has(ref)) continue; // ya alertado — no repetir cada ciclo

      const msg =
          `Ítem "${item.name}" (ref=${ref}, alegra_item_id=${item.id}) fue creado ` +
          `directamente en Alegra con categoría "Tienda Virtual y Física". No está ` +
          `registrado en el catálogo — su inventario NO se sincronizará con Shopify. ` +
          `Créalo desde Shopify o cambia su categoría en Alegra.`;

      logger.warn(`[AlegraOrphan] ${msg}`);
      await auditService.createAlert({ type: 'alegra_orphan_product', sku: ref, detail: msg });

      this.alertedAlegraOrphanRefs.add(ref);
    }

    // Limpiar del set los refs que ya no son huérfanos (se vincularon o se eliminaron en Alegra)
    for (const ref of this.alertedAlegraOrphanRefs) {
      if (!currentOrphanRefs.has(ref)) this.alertedAlegraOrphanRefs.delete(ref);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  CREACIÓN DE PRODUCTO DESDE SHOPIFY (webhook products/create)
  //  Una variante Shopify → un ítem independiente en Alegra.
  // ═══════════════════════════════════════════════════════════════════════════
  async handleProductCreate(shopifyProduct: ShopifyProduct): Promise<void> {
    logger.info(`Procesando producto Shopify: "${shopifyProduct.title}" (id=${shopifyProduct.id})`);

    for (const variant of shopifyProduct.variants) {
      // ── Validar SKU obligatorio ───────────────────────────────────────────
      if (!variant.sku || variant.sku.trim() === '') {
        logger.warn(`Variante ${variant.id} sin SKU. Omitida.`);
        await auditService.createAlert({
          type:   'sku_missing',
          detail: `Variante sin SKU en producto "${shopifyProduct.title}" ` +
              `(variant_id=${variant.id}). Asigna un SKU en Shopify para sincronizar.`,
        });
        continue;
      }

      // ── Tracking de inventario ────────────────────────────────────────────
      // inventory_management puede ser null cuando el tracking no está activado
      // en la location de Shopify. Esto NO impide crear el ítem en Alegra — solo
      // significa que el stock inicial puede ser 0. Se loguea como advertencia
      // informativa pero la creación continúa normalmente.
      if (variant.inventory_management !== 'shopify') {
        logger.warn(
            `Variante "${variant.sku}" (id=${variant.id}): ` +
            `inventory_management="${variant.inventory_management ?? 'null'}". ` +
            `El stock inicial será 0. Activa "Track quantity" en Shopify para sincronizar stock.`,
        );
      }

      // ── Idempotencia: si ya existe en catalog → skip ──────────────────────
      const existing = await prisma.productCatalog.findUnique({ where: { sku: variant.sku } });
      if (existing) {
        logger.debug(`SKU ${variant.sku} ya existe en catalog. Skip.`);
        continue;
      }

      try {
        const itemName = `${shopifyProduct.title} - ${variant.title}`;
        const price    = parseFloat(variant.price);

        // ── Obtener costo desde Shopify inventory item ────────────────────
        // El costo no viene en el webhook, hay que pedirlo por separado
        const cost = variant.inventory_item_id
            ? await shopifyConnector.getVariantCost(variant.inventory_item_id)
            : 0;

        // ── Crear ítem en Alegra ──────────────────────────────────────────
        // Los IDs de categoría y bodega se obtienen del bootstrap (resueltos
        // por nombre al arrancar). env.ALEGRA_WAREHOUSE_ID no existe — usar getAlegraIds().
        const { categoryId, warehouseId, accountTemplate } = getAlegraIds();

        // Construir el bloque "accounting" que Alegra espera.
        // IMPORTANTE: según la API oficial de Alegra, los valores de accounting
        // son strings con el ID directamente — NO objetos { id }.
        // accounting.inventory             → ID de cuenta de inventario (string)
        // accounting.inventariablePurchase → ID de cuenta costo de ventas (string)
        // La cuenta de ingresos va en "category" a nivel raíz (cuenta contable de ventas).
        // La categoría comercial (de items) va en "itemCategory".
        const accountingBlock = accountTemplate ? {
          ...(accountTemplate.inventoryAccount && { inventory:             String(accountTemplate.inventoryAccount.id) }),
          ...(accountTemplate.saleCost         && { inventariablePurchase: String(accountTemplate.saleCost.id) }),
        } : undefined;
        const payload: AlegraItemCreatePayload = {
          name:      itemName,
          reference: variant.sku,
          // itemCategory → categoría comercial del ítem (la de "Tienda Virtual y Física")
          itemCategory: { id: categoryId },
          // category → cuenta contable de ingresos por ventas (requerida por Alegra)
          ...(accountTemplate?.saleIncome && { category: { id: String(accountTemplate.saleIncome.id) } }),
          // accounting → cuentas contables de inventario y costo (IDs como strings simples)
          ...(accountingBlock && Object.keys(accountingBlock).length > 0 && { accounting: accountingBlock }),
          ...(accountTemplate?.tax && { tax: [{ id: String(accountTemplate.tax.id) }] }),
          inventory: {
            // Usar la unidad del ítem plantilla — el código interno de Alegra (ej: "unit")
            // puede diferir del nombre legible en el .env (ej: "Unidad").
            unit:            accountTemplate?.unit ?? env.ALEGRA_UNIT_OF_MEASURE,
            initialQuantity: variant.inventory_quantity,
            unitCost:        cost > 0 ? cost : undefined,
            minQuantity:     0,
            warehouses: [{
              id:              warehouseId,
              initialQuantity: variant.inventory_quantity,
            }],
          },
          price:    [{ idPriceList: (accountTemplate?.priceListId ?? 1) as number | string, price }],
          itemType: 'product',
        };

        logger.info(`[Debug] Payload enviado a Alegra para SKU ${variant.sku}: ${JSON.stringify(payload)}`);

        // ── Crear ítem en Alegra, con recuperación si la Referencia ya existe ──
        // Código 1009 = "La referencia X ya ha sido asignada a otro ítem".
        // Esto ocurre cuando product_catalog se vació (ej: tras una migración o
        // reset de BD) pero el ítem de Alegra de una corrida anterior sigue
        // existiendo. En ese caso, en lugar de fallar, buscamos el ítem
        // existente por reference y vinculamos product_catalog a él —
        // sin crear un duplicado ni perder el stock/historial ya presente en Alegra.
        let alegraItem;
        let linkedToExisting = false;

        try {
          alegraItem = await alegraConnector.createItem(payload);
        } catch (createErr) {
          const errData = (createErr as { response?: { data?: { code?: number; message?: string } } }).response?.data;

          if (errData?.code === 1009) {
            logger.warn(
                `Alegra: referencia "${variant.sku}" ya existe. Buscando ítem existente para vincular...`,
            );

            const existingItem = await alegraConnector.findItemByReference(variant.sku);

            if (!existingItem) {
              // No deberíamos llegar aquí (Alegra dice que existe pero la búsqueda no lo encuentra)
              throw createErr;
            }

            alegraItem      = existingItem;
            linkedToExisting = true;

            logger.info(
                `Alegra: vinculando SKU ${variant.sku} al ítem existente id=${existingItem.id} ` +
                `(stock actual en Alegra: ${existingItem.inventory?.availableQuantity ?? 0})`,
            );
          } else {
            throw createErr;
          }
        }

        // ── Insertar en product_catalog ───────────────────────────────────
        await prisma.productCatalog.create({
          data: {
            shopifyVariantId:       String(variant.id),
            shopifyProductId:       String(shopifyProduct.id),
            shopifyInventoryItemId: String(variant.inventory_item_id),
            alegraItemId:           String(alegraItem.id),
            sku:              variant.sku,
            lastKnownName:    itemName,
            lastKnownPrice:   price,
            lastKnownCost:    cost,
            lastKnownOption1: variant.option1 ?? variant.title,
            lastKnownOption2: variant.option2 ?? null,
            status:           'active',
          },
        });

        // ── Insertar en master_inventory ──────────────────────────────────
        // Si vinculamos a un ítem existente, usar el stock REAL que ya tiene
        // en Alegra (no el de Shopify) para no sobreescribir lo existente.
        // El siguiente ciclo de reconcileSku calculará el delta correcto.
        const initialStock = linkedToExisting
            ? (alegraItem.inventory?.availableQuantity ?? 0)
            : variant.inventory_quantity;

        await prisma.masterInventory.create({
          data: {
            sku:              variant.sku,
            stockGlobal:      initialStock,
            stockShopifyLast: linkedToExisting ? 0 : variant.inventory_quantity,
            stockAlegraLast:  initialStock,
            lastUpdatedBy:    'orchestrator',
          },
        });

        // ── Audit log ─────────────────────────────────────────────────────
        await auditService.log({
          idempotencyKey: buildIdempotencyKey(
              'shopify_webhook',
              `product_create_${variant.id}`,
              'status',
          ),
          sku:            variant.sku,
          fieldChanged:   'status',
          oldValue:       null,
          newValue:       linkedToExisting ? 'linked_existing' : 'active',
          origin:         'shopify_webhook',
          sourceEventRef: `shopify_product_${shopifyProduct.id}`,
          alertTriggered: linkedToExisting,
        });

        if (linkedToExisting) {
          await auditService.createAlert({
            type:   'orphan_repaired',
            sku:    variant.sku,
            detail: `product_catalog no tenía registro para SKU ${variant.sku}, pero ya existía ` +
                `como ítem ${alegraItem.id} en Alegra (stock=${initialStock}). ` +
                `Se vinculó al ítem existente en lugar de crear uno nuevo. ` +
                `Verifica que el stock_global sea correcto.`,
          });
        }

        logger.info(
            linkedToExisting
                ? `✅  SKU ${variant.sku} vinculado a ítem Alegra existente ${alegraItem.id} (Shopify variant ${variant.id})`
                : `✅  SKU ${variant.sku} sincronizado: Shopify variant ${variant.id} ↔ Alegra item ${alegraItem.id}`,
        );

      } catch (err) {
        logger.error(`Error creando SKU ${variant.sku} en Alegra:`, err);
        await auditService.createAlert({
          type:   'sku_missing',
          detail: `Error al crear SKU ${variant.sku} en Alegra: ${(err as Error).message}`,
        });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  ACTUALIZACIÓN DE PRODUCTO (webhook products/update)
  //  Busca por shopifyVariantId (no por SKU) para detectar SKU migrations.
  //  Diff contra last_known_* para saber exactamente qué cambió.
  // ═══════════════════════════════════════════════════════════════════════════
  async handleProductUpdate(shopifyProduct: ShopifyProduct): Promise<void> {
    // ── Detectar variantes eliminadas ─────────────────────────────────────────
    // Buscar variantes que teníamos de este producto pero ya no están en el payload
    const incomingVariantIds = new Set(shopifyProduct.variants.map((v) => String(v.id)));
    const existingCatalog    = await prisma.productCatalog.findMany({
      where: { shopifyProductId: String(shopifyProduct.id), status: 'active' },
    });

    for (const existing of existingCatalog) {
      if (!incomingVariantIds.has(existing.shopifyVariantId)) {
        // Esta variante desapareció del producto → archivar
        await this.archiveVariant(existing.shopifyVariantId, `${shopifyProduct.title} variante eliminada`);
      }
    }

    // ── Procesar cada variante del payload ────────────────────────────────────
    for (const variant of shopifyProduct.variants) {
      if (!variant.sku || variant.sku.trim() === '') continue;

      // CRÍTICO: buscar por shopifyVariantId, NO por SKU
      // Esto permite detectar cuando el SKU cambió (SKU migration)
      const catalog = await prisma.productCatalog.findFirst({
        where: { shopifyVariantId: String(variant.id) },
      });

      if (!catalog) {
        // Variante genuinamente nueva (nuevo variant_id) → flujo de creación
        await this.handleProductCreate({ ...shopifyProduct, variants: [variant] });
        continue;
      }

      // ── Detectar SKU migration ─────────────────────────────────────────────
      if (catalog.sku !== variant.sku) {
        await this.handleSkuMigration(catalog, variant.sku, shopifyProduct.id);
        // Después del migration, continuar con el resto del diff usando el nuevo SKU
      }

      // SKU actualizado (puede ser el mismo que antes o el nuevo del migration)
      const currentSku = variant.sku;
      const updates: Record<string, unknown> = {};

      // ── Diff nombre ────────────────────────────────────────────────────────
      const newName = `${shopifyProduct.title} - ${variant.title}`;
      if (newName !== catalog.lastKnownName) {
        await alegraConnector.updateItemName(catalog.alegraItemId, newName);

        const nameKey = buildIdempotencyKey(
            'shopify_webhook',
            `name_update_${variant.id}_${Date.now()}`,
            'name',
        );
        await auditService.log({
          idempotencyKey: nameKey,
          sku:            currentSku,
          fieldChanged:   'name',
          oldValue:       catalog.lastKnownName,
          newValue:       newName,
          origin:         'shopify_webhook',
          sourceEventRef: `product_update_${shopifyProduct.id}`,
        });
        updates.lastKnownName    = newName;
        updates.lastKnownOption1 = variant.option1 ?? variant.title;
        updates.lastKnownOption2 = variant.option2 ?? null;
      }

      // ── Diff precio ────────────────────────────────────────────────────────
      const newPrice = parseFloat(variant.price);
      if (Math.abs(newPrice - catalog.lastKnownPrice.toNumber()) > 0.01) {
        await alegraConnector.updateItemPrice(catalog.alegraItemId, newPrice);
        await auditService.logPriceChange({
          sku:            currentSku,
          oldPrice:       catalog.lastKnownPrice.toNumber(),
          newPrice,
          origin:         'shopify_webhook',
          sourceEventRef: `product_update_${variant.id}`,
        });
        updates.lastKnownPrice = newPrice;
      }

      // ── Diff costo (requiere llamada adicional a Shopify) ──────────────────
      if (variant.inventory_item_id) {
        const newCost = await shopifyConnector.getVariantCost(variant.inventory_item_id);
        if (newCost > 0 && Math.abs(newCost - catalog.lastKnownCost.toNumber()) > 0.01) {
          await alegraConnector.updateItemCost(catalog.alegraItemId, newCost);
          const costKey = buildIdempotencyKey(
              'shopify_webhook',
              `cost_update_${variant.id}_${Date.now()}`,
              'cost',
          );
          await auditService.log({
            idempotencyKey: costKey,
            sku:            currentSku,
            fieldChanged:   'cost',
            oldValue:       String(catalog.lastKnownCost.toNumber()),
            newValue:       String(newCost),
            origin:         'shopify_webhook',
            sourceEventRef: `product_update_${shopifyProduct.id}`,
          });
          updates.lastKnownCost = newCost;
        }
      }

      // ── Persistir actualizaciones al snapshot ──────────────────────────────
      if (Object.keys(updates).length > 0) {
        await prisma.productCatalog.update({
          where: { shopifyVariantId: String(variant.id) },
          data:  updates,
        });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SKU MIGRATION FLOW
  //  Se ejecuta cuando el SKU de una variante cambia en Shopify.
  //  NUNCA crea un ítem nuevo. Actualiza la Referencia del ítem existente.
  // ═══════════════════════════════════════════════════════════════════════════
  private async handleSkuMigration(
      catalog: { sku: string; alegraItemId: string; shopifyVariantId: string },
      newSku: string,
      shopifyProductId: number,
  ): Promise<void> {
    const oldSku = catalog.sku;

    logger.warn(`SKU migration detectado: ${oldSku} → ${newSku}`);

    // ── Verificar que el nuevo SKU no colisione con otro existente ────────────
    const collision = await prisma.productCatalog.findUnique({ where: { sku: newSku } });
    if (collision) {
      await auditService.createAlert({
        type:   'sku_migration',
        sku:    oldSku,
        detail: `SKU migration BLOQUEADO: el nuevo SKU "${newSku}" ya existe en el catálogo. ` +
            `Corrígelo en Shopify. El ítem mantiene el SKU "${oldSku}" hasta resolución.`,
      });
      logger.error(`SKU migration bloqueado — colisión con SKU existente: ${newSku}`);
      return; // No migrar — dejar el SKU anterior para no corromper datos
    }

    try {
      // 1. Actualizar la Referencia en Alegra (el ítem sigue siendo el mismo)
      await alegraConnector.updateItemReference(catalog.alegraItemId, newSku);

      // 2. Actualizar product_catalog
      //    La FK de master_inventory tiene ON UPDATE CASCADE → se actualiza solo
      await prisma.productCatalog.update({
        where: { shopifyVariantId: catalog.shopifyVariantId },
        data:  { sku: newSku },
      });

      // 3. Audit log con alerta alta prioridad
      const migKey = buildIdempotencyKey(
          'shopify_webhook',
          `sku_migration_${catalog.shopifyVariantId}`,
          'sku',
      );
      await auditService.log({
        idempotencyKey: migKey,
        sku:            newSku,       // SKU nuevo (el que queda)
        fieldChanged:   'sku',
        oldValue:       oldSku,
        newValue:       newSku,
        origin:         'shopify_webhook',
        sourceEventRef: `product_update_${shopifyProductId}`,
        alertTriggered: true,
      });

      await auditService.createAlert({
        type:   'sku_migration',
        sku:    newSku,
        detail: `SKU migrado: "${oldSku}" → "${newSku}". ` +
            `Ítem de Alegra ${catalog.alegraItemId} actualizado. ` +
            `El stock no fue modificado. Verifica la trazabilidad contable.`,
      });

      logger.info(`SKU migration completado: ${oldSku} → ${newSku}`);

    } catch (err) {
      logger.error(`Error en SKU migration ${oldSku} → ${newSku}:`, err);
      await auditService.createAlert({
        type:   'sku_migration',
        sku:    oldSku,
        detail: `SKU migration FALLIDO: ${oldSku} → ${newSku}. Error: ${(err as Error).message}. ` +
            `Intervención manual requerida.`,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  ARCHIVAR VARIANTE (variante eliminada de un producto en Shopify)
  //  NUNCA borra el ítem de Alegra — preserva el historial contable.
  // ═══════════════════════════════════════════════════════════════════════════
  private async archiveVariant(shopifyVariantId: string, context: string): Promise<void> {
    const catalog = await prisma.productCatalog.findFirst({
      where: { shopifyVariantId, status: 'active' },
    });
    if (!catalog) return;

    await alegraConnector.archiveItem(catalog.alegraItemId, catalog.lastKnownName);

    await prisma.productCatalog.update({
      where: { id: catalog.id },
      data:  { status: 'archived' },
    });

    const archKey = buildIdempotencyKey(
        'shopify_webhook',
        `variant_archived_${shopifyVariantId}`,
        'status',
    );
    await auditService.log({
      idempotencyKey: archKey,
      sku:            catalog.sku,
      fieldChanged:   'status',
      oldValue:       'active',
      newValue:       'archived',
      origin:         'shopify_webhook',
      sourceEventRef: context,
      alertTriggered: true,
    });

    await auditService.createAlert({
      type:   'variant_archived',
      sku:    catalog.sku,
      detail: `Variante "${catalog.lastKnownName}" (SKU: ${catalog.sku}) archivada en Alegra. ` +
          `Eliminada en Shopify. El historial contable se preserva.`,
    });

    logger.info(`Variante archivada: SKU ${catalog.sku}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  ELIMINACIÓN DE PRODUCTO (webhook products/delete)
  //  Archiva todas las variantes activas del producto.
  // ═══════════════════════════════════════════════════════════════════════════
  async handleProductDelete(shopifyProductId: string): Promise<void> {
    const variants = await prisma.productCatalog.findMany({
      where: { shopifyProductId, status: 'active' },
    });

    for (const variant of variants) {
      await this.archiveVariant(variant.shopifyVariantId, `product_delete_${shopifyProductId}`);
    }

    logger.info(`Producto ${shopifyProductId} eliminado: ${variants.length} variante(s) archivada(s)`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  RECONCILE ORPHANS
  //  Detecta product_catalog activos cuya contraparte ya no existe:
  //    - master_inventory faltante (borrado manualmente de la BD)
  //    - alegraItemId apuntando a un ítem borrado en Alegra (404 / NOT_FOUND)
  //
  //  Repara cada caso de forma independiente:
  //    - master_inventory faltante → se recrea leyendo el stock real de Shopify
  //    - ítem de Alegra inexistente → se re-crea en Alegra reutilizando el
  //      mismo flujo de creación (mismo payload que un producto nuevo),
  //      y se actualiza alegraItemId en product_catalog con el nuevo ID.
  //
  //  Es idempotente y se ejecuta en cada ciclo — si todo está sano, no hace nada.
  // ═══════════════════════════════════════════════════════════════════════════
  private async reconcileOrphans(): Promise<{ repaired: number; errors: string[] }> {
    const errors: string[] = [];
    let repaired = 0;

    const catalog = await prisma.productCatalog.findMany({
      where:   { status: 'active' },
      include: { inventory: true },
    });

    for (const entry of catalog) {
      // ── Caso 1: master_inventory faltante ─────────────────────────────────
      if (!entry.inventory) {
        try {
          logger.warn(
              `Orphan: SKU ${entry.sku} no tiene master_inventory. Recreando desde la realidad...`,
          );

          let stockReal = 0;
          try {
            const variantData = await shopifyConnector.getVariant(entry.shopifyVariantId);
            if (variantData.inventory_management === 'shopify') {
              await shopifyConnector.connectInventoryLevel(variantData.inventory_item_id);
              stockReal = await shopifyConnector.getInventoryLevel(variantData.inventory_item_id);
            }
          } catch (err) {
            logger.warn(`Orphan: no se pudo leer stock de Shopify para ${entry.sku}: ${(err as Error).message}`);
          }

          // Si Shopify no reporta nada útil, intentar leer de Alegra como respaldo
          if (stockReal === 0) {
            try {
              const alegraItem = await alegraConnector.getItem(entry.alegraItemId);
              stockReal = alegraItem.inventory?.warehouses?.[0]?.availableQuantity ?? 0;
            } catch {
              // Si Alegra tampoco responde, se maneja en el Caso 2 más abajo
            }
          }

          await prisma.masterInventory.create({
            data: {
              sku:              entry.sku,
              stockGlobal:      stockReal,
              stockShopifyLast: stockReal,
              stockAlegraLast:  stockReal,
              lastUpdatedBy:    'orchestrator',
            },
          });

          await auditService.log({
            idempotencyKey: buildIdempotencyKey('orchestrator', `orphan_repair_inventory_${entry.sku}_${Date.now()}`, 'status'),
            sku:            entry.sku,
            fieldChanged:   'status',
            oldValue:       'missing_master_inventory',
            newValue:       String(stockReal),
            origin:         'orchestrator',
            sourceEventRef: 'reconcile_orphans',
            alertTriggered: true,
          });

          await auditService.createAlert({
            type:   'orphan_repaired',
            sku:    entry.sku,
            detail: `master_inventory faltante para SKU ${entry.sku}. Recreado con stock=${stockReal} ` +
                `leído desde ${stockReal > 0 ? 'la plataforma real' : 'valor por defecto 0'}. ` +
                `Verifica que el stock sea correcto.`,
          });

          repaired++;
          logger.info(`Orphan: master_inventory recreado para SKU ${entry.sku} con stock=${stockReal}`);

          // Refrescar entry.inventory para el Caso 2 (evita doble-fetch)
          entry.inventory = await prisma.masterInventory.findUnique({ where: { sku: entry.sku } });
        } catch (err) {
          const msg = `Orphan: error recreando master_inventory para ${entry.sku}: ${(err as Error).message}`;
          logger.error(msg);
          errors.push(msg);
          continue; // No intentar el Caso 2 si esto falló
        }
      }

      // ── Caso 2: el ítem de Alegra ya no existe (fue borrado externamente) ──
      try {
        await alegraConnector.getItem(entry.alegraItemId);
        // Si no lanza, el ítem existe — todo OK, no hacer nada
      } catch (err) {
        const status = (err as { response?: { status?: number } }).response?.status;
        const isNotFound = status === 404 || status === 400; // Alegra devuelve 400 para IDs inexistentes en algunos casos

        if (!isNotFound) {
          // Error de red/temporal — no es un huérfano, no reparar agresivamente
          const msg = `Orphan: error verificando ítem Alegra ${entry.alegraItemId} (SKU ${entry.sku}): ${(err as Error).message}`;
          logger.warn(msg);
          continue;
        }

        try {
          logger.warn(
              `Orphan: ítem Alegra ${entry.alegraItemId} (SKU ${entry.sku}) no existe. Recreando en Alegra...`,
          );

          const oldAlegraItemId = entry.alegraItemId;
          const newAlegraItemId = await this.recreateAlegraItem(entry);

          await prisma.productCatalog.update({
            where: { sku: entry.sku },
            data:  { alegraItemId: newAlegraItemId },
          });

          await auditService.log({
            idempotencyKey: buildIdempotencyKey('orchestrator', `orphan_repair_alegra_${entry.sku}_${Date.now()}`, 'status'),
            sku:            entry.sku,
            fieldChanged:   'status',
            oldValue:       `alegra_item_${oldAlegraItemId}_missing`,
            newValue:       `alegra_item_${newAlegraItemId}`,
            origin:         'orchestrator',
            sourceEventRef: 'reconcile_orphans',
            alertTriggered: true,
          });

          await auditService.createAlert({
            type:   'orphan_repaired',
            sku:    entry.sku,
            detail: `Ítem de Alegra ${oldAlegraItemId} (SKU ${entry.sku}) no existía. ` +
                `Recreado como ítem ${newAlegraItemId} con el stock actual de master_inventory. ` +
                `Verifica que la información contable sea correcta.`,
          });

          repaired++;
          logger.info(`Orphan: ítem Alegra recreado para SKU ${entry.sku} → nuevo id=${newAlegraItemId}`);
        } catch (recreateErr) {
          const msg = `Orphan: error recreando ítem Alegra para ${entry.sku}: ${(recreateErr as Error).message}`;
          logger.error(msg);
          errors.push(msg);
        }
      }
    }

    return { repaired, errors };
  }

  /**
   * Recrea un ítem en Alegra para un SKU cuyo ítem original fue borrado.
   * Usa el stock actual de master_inventory y los last_known_* de product_catalog
   * (precio, costo, nombre) — no depende de Shopify para estos valores porque
   * ya están cacheados localmente.
   * Devuelve el nuevo alegraItemId.
   */
  private async recreateAlegraItem(entry: {
    sku:              string;
    lastKnownName:    string;
    lastKnownPrice:   { toNumber(): number };
    lastKnownCost:    { toNumber(): number };
    inventory:        { stockGlobal: number } | null;
  }): Promise<string> {
    const { categoryId, warehouseId, accountTemplate } = getAlegraIds();
    const stock = entry.inventory?.stockGlobal ?? 0;
    const price = entry.lastKnownPrice.toNumber();
    const cost  = entry.lastKnownCost.toNumber();

    const accountingBlock = accountTemplate ? {
      ...(accountTemplate.inventoryAccount && { inventory:             String(accountTemplate.inventoryAccount.id) }),
      ...(accountTemplate.saleCost         && { inventariablePurchase: String(accountTemplate.saleCost.id) }),
    } : undefined;

    const payload: AlegraItemCreatePayload = {
      name:      entry.lastKnownName,
      reference: entry.sku,
      itemCategory: { id: categoryId },
      ...(accountTemplate?.saleIncome && { category: { id: String(accountTemplate.saleIncome.id) } }),
      ...(accountingBlock && Object.keys(accountingBlock).length > 0 && { accounting: accountingBlock }),
      ...(accountTemplate?.tax && { tax: [{ id: String(accountTemplate.tax.id) }] }),
      inventory: {
        unit:            accountTemplate?.unit ?? env.ALEGRA_UNIT_OF_MEASURE,
        initialQuantity: stock,
        unitCost:        cost > 0 ? cost : undefined,
        minQuantity:     0,
        warehouses: [{ id: warehouseId, initialQuantity: stock }],
      },
      price:    [{ idPriceList: (accountTemplate?.priceListId ?? 1) as number | string, price }],
      itemType: 'product',
    };

    const alegraItem = await alegraConnector.createItem(payload);
    return String(alegraItem.id);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  RESET MASTER FROM REALITY
  //  Resincroniza master_inventory con el stock REAL actual de ambas plataformas.
  //  Usar cuando los _last están desincronizados (ej: tras activar tracking,
  //  tras errores de creación, o tras una migración manual de datos).
  //  No genera delta — solo alinea el estado conocido con la realidad.
  // ═══════════════════════════════════════════════════════════════════════════
  async resetMasterFromReality(sku?: string): Promise<{
    skusReset: number;
    results: Array<{ sku: string; shopify: number; alegra: string; newGlobal: number; tracking: string }>;
  }> {
    const whereClause = sku
        ? { sku, status: 'active' as const }
        : { status: 'active' as const };

    const catalog = await prisma.productCatalog.findMany({
      where:   whereClause,
      include: { inventory: true },
    });

    const results: Array<{ sku: string; shopify: number; alegra: string; newGlobal: number; tracking: string }> = [];

    for (const entry of catalog) {
      try {
        const variantData            = await shopifyConnector.getVariant(entry.shopifyVariantId);
        const shopifyInventoryItemId = variantData.inventory_item_id;
        const shopifyTracking        = variantData.inventory_management;

        // Si tiene tracking, conectar primero a la location (en caso de que no esté)
        if (shopifyTracking === 'shopify') {
          await shopifyConnector.connectInventoryLevel(shopifyInventoryItemId);
        }

        const currentShopify = shopifyTracking === 'shopify'
            ? await shopifyConnector.getInventoryLevel(shopifyInventoryItemId)
            : entry.inventory?.stockGlobal ?? 0;

        const alegraItem    = await alegraConnector.getItem(entry.alegraItemId);
        const currentAlegra = alegraItem.inventory?.warehouses?.[0]?.availableQuantity ?? 0;

        // El nuevo global es el máximo de lo que ambas plataformas reportan.
        // No restamos nada — solo alineamos el estado conocido.
        const newGlobal = shopifyTracking === 'shopify'
            ? Math.max(currentShopify, currentAlegra)
            : currentAlegra;

        await prisma.masterInventory.update({
          where: { sku: entry.sku },
          data: {
            stockGlobal:      newGlobal,
            stockShopifyLast: shopifyTracking === 'shopify' ? currentShopify : newGlobal,
            stockAlegraLast:  currentAlegra,
            lastUpdatedBy:    'manual_reset',
          },
        });

        // Si Shopify tiene tracking y el stock difiere → sincronizar
        if (shopifyTracking === 'shopify' && currentShopify !== newGlobal) {
          await shopifyConnector.setInventoryLevel(shopifyInventoryItemId, newGlobal);
        }

        // Si Alegra difiere → ajustar
        if (currentAlegra !== newGlobal) {
          const adjustQty = newGlobal - currentAlegra;
          await alegraConnector.adjustStock(
              entry.alegraItemId,
              adjustQty,
              `Reset manual desde realidad — stock ajustado a ${newGlobal}`,
              entry.lastKnownCost.toNumber(),  // preservar costo promedio en Alegra
          );
        }

        results.push({
          sku:       entry.sku,
          shopify:   currentShopify,
          alegra:    String(currentAlegra),
          newGlobal,
          tracking:  shopifyTracking ?? 'none',
        });

        logger.info(
            `Reset SKU ${entry.sku}: shopify=${currentShopify} alegra=${currentAlegra} → global=${newGlobal} (tracking=${shopifyTracking ?? 'none'})`,
        );
      } catch (err) {
        logger.error(`Reset: error en SKU ${entry.sku}:`, err);
        results.push({ sku: entry.sku, shopify: -1, alegra: 'error', newGlobal: -1, tracking: 'error' });
      }
    }

    return { skusReset: results.filter(r => r.newGlobal >= 0).length, results };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  FORCE SYNC para un SKU específico (endpoint operador)
  // ═══════════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════════
  //  SINCRONIZACIÓN RÁPIDA — SOLO CAMBIOS DE ALEGRA
  //  A diferencia de runPollingCycle (que recorre TODO el catálogo llamando a
  //  Shopify y Alegra por cada SKU, uno por uno), este job:
  //   1. Trae TODOS los ítems de Alegra en pocas llamadas (paginado, ya
  //      existente en getSyncedItems), no una llamada por SKU.
  //   2. Compara en memoria contra el último stock conocido de Alegra.
  //   3. Solo escribe a Shopify los SKUs que de verdad cambiaron — no todos.
  //
  //  Los cambios del lado de Shopify (ventas, ajustes manuales) YA son
  //  instantáneos vía el webhook inventory_levels/update — este job cubre
  //  el único caso que Alegra no puede avisarnos por sí solo: alguien
  //  ajustó el stock directamente ahí, sin pasar por Shopify.
  //
  //  Por diseño puede correr cada 20-30s sin problema, incluso con miles de
  //  SKUs, porque su costo NO escala con el catálogo — escala con cuántos
  //  ítems trae cada página de Alegra (unas pocas llamadas fijas), no con
  //  cuántos SKUs tengas registrados.
  // ═══════════════════════════════════════════════════════════════════════════
  // Antes: un simple booleano (isFastSyncing) hacía que una segunda llamada
  // mientras ya había una corrida en curso devolviera un resultado vacío de
  // inmediato (silencioso "no-op") — esto era un problema real si, por
  // ejemplo, el catchup se disparaba justo cuando la corrida periódica de
  // cada 30s ya estaba en curso: el catchup creería que ya reconcilió todo,
  // sin haber hecho nada en realidad.
  //
  // Ahora: se usa una promesa compartida. Si ya hay una corrida en curso,
  // cualquier llamada nueva espera a que termine esa, y luego dispara una
  // corrida propia — así SIEMPRE se obtiene un resultado real, nunca uno
  // vacío por coincidencia de tiempos.
  private fastSyncInFlight: Promise<{ checked: number; changed: number; errors: string[] }> | null = null;

  async fastAlegraSync(): Promise<{ checked: number; changed: number; errors: string[] }> {
    if (this.fastSyncInFlight) {
      // Esperar a que termine la corrida actual (ignorando si falló, para no
      // propagar un error ajeno a este llamador) y luego correr una propia.
      await this.fastSyncInFlight.catch(() => undefined);
      return this.fastAlegraSync();
    }

    this.fastSyncInFlight = this.runFastAlegraSyncOnce();
    try {
      return await this.fastSyncInFlight;
    } finally {
      this.fastSyncInFlight = null;
    }
  }

  private async runFastAlegraSyncOnce(): Promise<{ checked: number; changed: number; errors: string[] }> {
    const result = { checked: 0, changed: 0, errors: [] as string[] };

    try {
      // ── 1. Traer TODOS los ítems de Alegra en bloque (pocas llamadas) ─────
      const alegraItems = await alegraConnector.getSyncedItems();
      const alegraStockByRef = new Map<string, number>();
      for (const item of alegraItems) {
        const ref = item.reference?.trim();
        if (!ref) continue;
        alegraStockByRef.set(ref, item.inventory?.warehouses?.[0]?.availableQuantity ?? 0);
      }

      // ── 2. Traer catálogo activo con su inventory conocido ────────────────
      const catalog = await prisma.productCatalog.findMany({
        where:   { status: 'active' },
        include: { inventory: true },
      });
      result.checked = catalog.length;

      // ── 3. Comparar en memoria — sin llamar a Alegra ni Shopify por SKU ───
      for (const entry of catalog) {
        if (!entry.inventory) continue;

        const currentAlegra = alegraStockByRef.get(entry.sku);
        if (currentAlegra === undefined) continue; // no está en Alegra (huérfano, ya cubierto aparte)

        // Pre-filtro barato usando la instantánea del inicio del ciclo — si acá
        // ya sugiere "sin cambios", casi seguro es así. El cálculo real y
        // definitivo ocurre DENTRO del candado, con una lectura fresca.
        const deltaAlegraPreview = entry.inventory.stockAlegraLast - currentAlegra;
        if (deltaAlegraPreview === 0) continue;

        try {
          const didChange = await this.skuMutex.runExclusive(entry.sku, async (): Promise<boolean> => {
            // ── Releer el estado fresco DENTRO del candado ──────────────────
            // La instantánea `entry.inventory` se tomó al inicio de la función,
            // antes de adquirir este candado. Si el webhook de Shopify (u otro
            // proceso) reconcilió este mismo SKU mientras esperábamos nuestro
            // turno, esa instantánea ya está vieja — usarla igual sobrescribiría
            // silenciosamente esa corrección (el bug que encontramos con el
            // SKU 90421). Por eso releemos aquí, ya con el candado en mano.
            const fresh = await prisma.masterInventory.findUnique({ where: { sku: entry.sku } });
            if (!fresh) return false;

            const deltaAlegra = fresh.stockAlegraLast - currentAlegra;
            if (deltaAlegra === 0) return false; // otro proceso ya lo dejó al día mientras esperábamos

            const oldGlobal = fresh.stockGlobal;
            const newGlobal = Math.max(0, oldGlobal - deltaAlegra);

            logger.info(
                `[FastAlegraSync] SKU ${entry.sku}: cambio detectado en Alegra ` +
                `(Δ=${deltaAlegra}) → nuevo stock global=${newGlobal}`,
            );

            // ── Escribir a Shopify PRIMERO, antes de tocar la base de datos ──────
            // BUG CORREGIDO: antes se actualizaba stockShopifyLast=viejo (sin
            // tocarlo) mientras SÍ se escribía el valor nuevo real en Shopify.
            // Eso dejaba un "delta fantasma" acumulándose en stockShopifyLast,
            // que el ciclo lento (reconcileSku) descubría después y reaplicaba
            // como si fuera un cambio nuevo — restando unidades que nunca se
            // vendieron. Ahora: solo marcamos stockShopifyLast como sincronizado
            // si la escritura a Shopify realmente tuvo éxito.
            let shopifyWriteOk = false;

            if (entry.shopifyInventoryItemId) {
              try {
                await shopifyConnector.setInventoryLevel(Number(entry.shopifyInventoryItemId), newGlobal);
                shopifyWriteOk = true;
              } catch (shopifyErr) {
                logger.warn(
                    `[FastAlegraSync] SKU ${entry.sku}: no se pudo escribir a Shopify ` +
                    `(¿sin "Track quantity"?): ${(shopifyErr as Error).message}`,
                );
              }
            } else {
              logger.warn(
                  `[FastAlegraSync] SKU ${entry.sku}: sin shopifyInventoryItemId todavía ` +
                  `(pendiente de backfill) — el ciclo lento lo completará.`,
              );
            }

            await prisma.masterInventory.update({
              where: { sku: entry.sku },
              data:  {
                stockGlobal:     newGlobal,
                stockAlegraLast: newGlobal,
                // Solo si la escritura a Shopify fue exitosa marcamos ese lado
                // como sincronizado. Si falló o no se pudo escribir, dejamos el
                // valor anterior — así el ciclo lento sabe que ese lado sigue
                // pendiente de verdad, en vez de asumir un éxito que no ocurrió.
                stockShopifyLast: shopifyWriteOk ? newGlobal : fresh.stockShopifyLast,
                lastUpdated:      new Date(),
                lastUpdatedBy:    'fast_alegra_sync',
              },
            });


            await auditService.logStockChange({
              sku:            entry.sku,
              oldStock:       oldGlobal,
              newStock:       newGlobal,
              origin:         'orchestrator',
              sourceEventRef: `fast_alegra_sync_${Date.now()}_${entry.sku}`,
            });

            return true;
          });

          if (didChange) result.changed++;
        } catch (err) {
          const msg = `[FastAlegraSync] Error procesando SKU ${entry.sku}: ${(err as Error).message}`;
          logger.error(msg);
          result.errors.push(msg);
        }
      }
    } catch (err) {
      const msg = `[FastAlegraSync] Error general: ${(err as Error).message}`;
      logger.error(msg);
      result.errors.push(msg);
    }

    return result;
  }

  async forceSyncSku(sku: string): Promise<{
    before:       { stockGlobal: number; alegra: number; shopify: number };
    after:        { stockGlobal: number; alegra: number; shopify: number };
    deltaApplied: boolean;
    durationMs:   number;
  }> {
    const start     = Date.now();
    const inventory = await prisma.masterInventory.findUnique({ where: { sku } });
    const catalog   = await prisma.productCatalog.findUnique({ where: { sku } });

    if (!inventory || !catalog) {
      throw new Error(`SKU ${sku} no encontrado en master_inventory o product_catalog`);
    }

    const before = {
      stockGlobal: inventory.stockGlobal,
      alegra:      inventory.stockAlegraLast,
      shopify:     inventory.stockShopifyLast,
    };

    await this.reconcileSku({ ...catalog, inventory });

    const updated = await prisma.masterInventory.findUnique({ where: { sku } });
    const after   = {
      stockGlobal: updated!.stockGlobal,
      alegra:      updated!.stockAlegraLast,
      shopify:     updated!.stockShopifyLast,
    };

    return {
      before,
      after,
      deltaApplied: before.stockGlobal !== after.stockGlobal,
      durationMs:   Date.now() - start,
    };
  }
}

// Singleton
export const orchestrator = new OrchestratorCore();