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

      // ── Obtener todos los SKUs sincronizados activos ───────────────────────
      const catalog = await prisma.productCatalog.findMany({
        where:   { status: 'active' },
        include: { inventory: true },
      });

      result.skusChecked = catalog.length;

      // ── Procesar cada SKU ──────────────────────────────────────────────────
      for (const entry of catalog) {
        try {
          const changed = await this.reconcileSku(entry);
          // deltasApplied cuenta solo los SKUs donde realmente se aplicó un cambio
          if (changed) result.deltasApplied++;
        } catch (err) {
          const msg = `Error reconciliando SKU ${entry.sku}: ${(err as Error).message}`;
          logger.error(msg);
          result.errors.push(msg);
        }
      }

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
  private async reconcileSku(entry: {
    sku:              string;
    shopifyVariantId: string;
    alegraItemId:     string;
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
    const shopifyInventoryItemId = await shopifyConnector.getVariantInventoryItemId(shopifyVariantId);
    const currentShopify = await shopifyConnector.getInventoryLevel(shopifyInventoryItemId);
    const alegraItem     = await alegraConnector.getItem(alegraItemId);
    const currentAlegra  = alegraItem.inventory?.warehouses?.[0]?.availableQuantity ?? 0;

    // ── 2. Calcular deltas REALES (no snapshot comparison) ────────────────
    // RF-03: si ambas plataformas vendieron, capturamos ambos deltas independientemente
    const deltaShopify = master.stockShopifyLast - currentShopify;
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
          stockShopifyLast: newGlobal,
          stockAlegraLast:  newGlobal,
          lastUpdated:      new Date(),
          lastUpdatedBy:    'orchestrator',
        },
      });

      // ── 5. Propagar a ambas plataformas ──────────────────────────────────
      const sourceRef = `poll_${Date.now()}_${sku}`;

      await shopifyConnector.setInventoryLevel(shopifyInventoryItemId, newGlobal);

      const adjustQty = newGlobal - currentAlegra;
      if (adjustQty !== 0) {
        await alegraConnector.adjustStock(
            alegraItemId,
            adjustQty,
            `Sync Bagatta Middleware — Δshopify:${deltaShopify} Δalegra:${deltaAlegra}`,
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
      let skusReconciled = 0;

      // ── Catchup rediseñado: comparación directa de stock actual ───────────
      //
      // El enfoque original usaba GET /orders.json para calcular deltas por
      // órdenes, pero ese endpoint requiere aprobación especial de Shopify para
      // "protected customer data" (error 403 en apps no aprobadas).
      //
      // Solución equivalente y más robusta: leer el stock ACTUAL de cada
      // plataforma y aplicar la misma fórmula de delta que usa el ciclo normal.
      // El resultado es idéntico — si hubo ventas durante el downtime, el stock
      // actual será menor que el _last guardado en master_inventory, y el delta
      // se calcula igual:
      //   delta_shopify = stock_shopify_last - stock_shopify_actual
      //   delta_alegra  = stock_alegra_last  - stock_alegra_actual
      //   stock_nuevo   = stock_global - delta_shopify - delta_alegra
      //
      // Esta estrategia no requiere permisos de órdenes ni datos de clientes.

      const catalog = await prisma.productCatalog.findMany({
        where:   { status: 'active' },
        include: { inventory: true },
      });

      for (const entry of catalog) {
        if (!entry.inventory) continue;

        const { sku, shopifyVariantId, alegraItemId } = entry;
        const master = entry.inventory;

        try {
          // Leer stock actual en ambas plataformas (igual que reconcileSku)
          const shopifyInventoryItemId = await shopifyConnector.getVariantInventoryItemId(shopifyVariantId);
          const currentShopify = await shopifyConnector.getInventoryLevel(shopifyInventoryItemId);
          const alegraItem     = await alegraConnector.getItem(alegraItemId);
          const currentAlegra  = alegraItem.inventory?.warehouses?.[0]?.availableQuantity ?? 0;

          // Calcular deltas reales acumulados durante el downtime
          const deltaShopify = master.stockShopifyLast - currentShopify;
          const deltaAlegra  = master.stockAlegraLast  - currentAlegra;

          if (deltaShopify === 0 && deltaAlegra === 0) continue; // sin cambios

          const oldGlobal = master.stockGlobal;
          const newGlobal = Math.max(0, oldGlobal - deltaShopify - deltaAlegra);

          logger.info(
              `Catchup SKU ${sku}: master=${oldGlobal}, ` +
              `Δshopify=${deltaShopify}, Δalegra=${deltaAlegra} → nuevo=${newGlobal}`,
          );

          await prisma.masterInventory.update({
            where: { sku },
            data:  {
              stockGlobal:      newGlobal,
              stockShopifyLast: newGlobal,
              stockAlegraLast:  newGlobal,
              lastUpdatedBy:    'catchup_sync',
            },
          });

          // Propagar a Shopify
          await shopifyConnector.setInventoryLevel(shopifyInventoryItemId, newGlobal);

          // Propagar a Alegra (ajuste relativo al stock actual)
          const adjustQty = newGlobal - currentAlegra;
          if (adjustQty !== 0) {
            await alegraConnector.adjustStock(
                alegraItemId,
                adjustQty,
                `Catchup sync — downtime de ${gapMinutes.toFixed(0)} min`,
            );
          }

          await auditService.logStockChange({
            sku,
            oldStock:       oldGlobal,
            newStock:       newGlobal,
            origin:         'catchup_sync',
            sourceEventRef: `catchup_${since.toISOString()}`,
          });

          skusReconciled++;
        } catch (skuErr) {
          logger.error(`Catchup: error reconciliando SKU ${sku}:`, skuErr);
          // Continuar con el siguiente SKU — no abortar todo el catchup por uno
        }
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
        const { categoryId, warehouseId } = getAlegraIds();
        const payload: AlegraItemCreatePayload = {
          name:      itemName,
          reference: variant.sku,
          category:  { id: categoryId },
          inventory: {
            unit:            env.ALEGRA_UNIT_OF_MEASURE,
            initialQuantity: variant.inventory_quantity,
            unitCost:        cost > 0 ? cost : undefined,
            minQuantity:     0,
            warehouses: [{
              id:              warehouseId,
              initialQuantity: variant.inventory_quantity,
            }],
          },
          price:    [{ idPriceList: 1, price }],
          itemType: 'product',
        };

        const alegraItem = await alegraConnector.createItem(payload);

        // ── Insertar en product_catalog ───────────────────────────────────
        await prisma.productCatalog.create({
          data: {
            shopifyVariantId: String(variant.id),
            shopifyProductId: String(shopifyProduct.id),
            alegraItemId:     String(alegraItem.id),
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
        await prisma.masterInventory.create({
          data: {
            sku:              variant.sku,
            stockGlobal:      variant.inventory_quantity,
            stockShopifyLast: variant.inventory_quantity,
            stockAlegraLast:  variant.inventory_quantity,
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
          newValue:       'active',
          origin:         'shopify_webhook',
          sourceEventRef: `shopify_product_${shopifyProduct.id}`,
        });

        logger.info(
            `✅  SKU ${variant.sku} sincronizado: Shopify variant ${variant.id} ↔ Alegra item ${alegraItem.id}`,
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
  //  FORCE SYNC para un SKU específico (endpoint operador)
  // ═══════════════════════════════════════════════════════════════════════════
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