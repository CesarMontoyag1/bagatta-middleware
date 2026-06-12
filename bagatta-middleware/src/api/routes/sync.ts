import { Router, Request, Response, NextFunction } from 'express';
import { verifyJwt, requireRole } from '../middlewares/auth';
import { orchestrator } from '../../orchestrator/core';
import { sseService } from '../../services/sse';
import { auditService } from '../../services/audit';
import { prisma } from '../../db/prisma';
import { shopifyConnector } from '../../orchestrator/connectors/shopify';
import { NotFoundError, CatchupInProgressError } from '../../utils/errors';
import { buildIdempotencyKey } from '../../utils/idempotency';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

// ── SSE /sync/stream ──────────────────────────────────────────────────────────
// El token se acepta como query param porque EventSource no soporta headers
router.get('/stream', verifyJwt, requireRole('readonly'), (_req: Request, res: Response) => {
  const clientId = uuidv4();
  sseService.addClient(clientId, res);
  // La conexión se mantiene abierta — sseService gestiona el cierre
});

// ── POST /sync/force/:sku ─────────────────────────────────────────────────────
router.post('/force/:sku', verifyJwt, requireRole('operator'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sku } = req.params;

    if (orchestrator.syncingStatus.isInCatchup) throw new CatchupInProgressError();

    // Verificar que el SKU existe y está activo
    const catalog = await prisma.productCatalog.findUnique({ where: { sku } });
    if (!catalog) throw new NotFoundError('SKU', sku);
    if (catalog.status !== 'active') throw new NotFoundError('SKU activo', sku);

    const result = await orchestrator.forceSyncSku(sku);

    // Audit log del force sync
    const idempKey = buildIdempotencyKey('manual_admin', `force_sync_${sku}`, `stock_${Date.now()}`);
    const auditId = await auditService.log({
      idempotencyKey: idempKey,
      sku,
      fieldChanged:   'stock',
      oldValue:       String(result.before.stockGlobal),
      newValue:       String(result.after.stockGlobal),
      origin:         'manual_admin',
      sourceEventRef: `force_sync_${req.user!.sub}`,
    });

    res.json({
      sku,
      status:        'synced',
      before:        result.before,
      after:         result.after,
      delta_applied: result.deltaApplied,
      audit_log_id:  auditId,
      duration_ms:   result.durationMs,
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /sync/force/global ───────────────────────────────────────────────────
router.post('/force/global', verifyJwt, requireRole('operator'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    if (orchestrator.syncingStatus.isInCatchup) throw new CatchupInProgressError();
    if (orchestrator.syncingStatus.isSyncing) {
      res.status(409).json({
        error: { code: 'SYNC_IN_PROGRESS', message: 'Ya hay un ciclo de sincronización en curso.' },
      });
      return;
    }

    const startTs = Date.now();
    const result = await orchestrator.runPollingCycle();

    res.json({
      status:       'completed',
      skus_checked: result.skusChecked,
      deltas:       result.deltasApplied,
      errors:       result.errors,
      duration_ms:  result.durationMs,
      started_at:   new Date(startTs).toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /sync/ingest-product/:shopifyProductId ───────────────────────────────
// Recuperación manual de un producto que no fue captado por el webhook.
// Busca el producto directamente en la API de Shopify y ejecuta el flujo
// de creación como si hubiera llegado el webhook products/create.
// Útil cuando: el webhook falló por HMAC, el middleware estaba caído,
// o el producto fue creado antes de instalar la app.
router.post(
    '/ingest-product/:shopifyProductId',
    verifyJwt,
    requireRole('operator'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { shopifyProductId } = req.params;

        // Validar que es un ID numérico válido de Shopify
        if (!/^\d+$/.test(shopifyProductId)) {
          res.status(400).json({
            error: {
              code:    'INVALID_PRODUCT_ID',
              message: 'El shopifyProductId debe ser un número entero (ej: 1234567890).',
            },
          });
          return;
        }

        // Obtener el producto directamente desde Shopify
        let shopifyProduct;
        try {
          shopifyProduct = await shopifyConnector.getProduct(shopifyProductId);
        } catch (err: unknown) {
          const status = (err as { response?: { status?: number } }).response?.status;
          if (status === 404) {
            res.status(404).json({
              error: {
                code:    'SHOPIFY_PRODUCT_NOT_FOUND',
                message: `El producto ${shopifyProductId} no existe en Shopify.`,
              },
            });
          } else {
            res.status(502).json({
              error: {
                code:    'SHOPIFY_API_ERROR',
                message: `Error consultando Shopify: ${(err as Error).message}`,
              },
            });
          }
          return;
        }

        // Diagnóstico previo: qué variantes tienen problemas
        const diagnostics = shopifyProduct.variants.map((v) => ({
          variant_id:           v.id,
          sku:                  v.sku || '(sin SKU)',
          inventory_management: v.inventory_management,
          inventory_quantity:   v.inventory_quantity,
          already_in_catalog:   false, // se actualiza abajo
          will_be_synced:       !!(v.sku && v.inventory_management === 'shopify'),
          skip_reason:          !v.sku
              ? 'Sin SKU'
              : v.inventory_management !== 'shopify'
                  ? `inventory_management="${v.inventory_management ?? 'null'}" (debe ser "shopify")`
                  : null,
        }));

        // Marcar cuáles ya están en el catálogo
        for (const diag of diagnostics) {
          if (diag.sku && diag.sku !== '(sin SKU)') {
            const exists = await prisma.productCatalog.findUnique({ where: { sku: diag.sku } });
            diag.already_in_catalog = !!exists;
          }
        }

        const willSync   = diagnostics.filter((d) => d.will_be_synced && !d.already_in_catalog);
        const skipped    = diagnostics.filter((d) => !d.will_be_synced || d.already_in_catalog);

        if (willSync.length === 0) {
          res.json({
            status:       'nothing_to_do',
            product_id:   shopifyProductId,
            product_title: shopifyProduct.title,
            message:      'Ninguna variante requiere sincronización. Ver diagnóstico.',
            diagnostics,
          });
          return;
        }

        // Ejecutar el flujo de creación (idempotente — skipea los que ya existen)
        await orchestrator.handleProductCreate(shopifyProduct);

        // Verificar qué quedó efectivamente creado
        const created: string[] = [];
        for (const diag of willSync) {
          const inCatalog = await prisma.productCatalog.findUnique({ where: { sku: diag.sku } });
          if (inCatalog) created.push(diag.sku);
        }

        res.json({
          status:        'completed',
          product_id:    shopifyProductId,
          product_title: shopifyProduct.title,
          variants_synced: created,
          variants_skipped: skipped.map((d) => ({
            sku:         d.sku,
            reason:      d.already_in_catalog ? 'Ya estaba en el catálogo' : d.skip_reason,
          })),
          diagnostics,
        });
      } catch (err) {
        next(err);
      }
    },
);

// ── POST /sync/reset-master ───────────────────────────────────────────────────
// Resincroniza master_inventory con el stock real actual de Shopify y Alegra.
// Usar cuando los _last están desincronizados:
//   - Tras activar "Track quantity" en Shopify
//   - Tras errores de creación del ciclo inicial
//   - Tras cualquier ajuste manual de stock en alguna plataforma
// Body opcional: { "sku": "8824" } para resetear solo un SKU.
// Sin body: resetea todos los SKUs activos.
router.post('/reset-master', verifyJwt, requireRole('operator'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (orchestrator.syncingStatus.isInCatchup) throw new CatchupInProgressError();

    const sku = (req.body as { sku?: string }).sku;

    // Si se especifica un SKU, verificar que existe
    if (sku) {
      const catalog = await prisma.productCatalog.findUnique({ where: { sku } });
      if (!catalog) throw new NotFoundError('SKU', sku);
    }

    const result = await orchestrator.resetMasterFromReality(sku);

    res.json({
      status:     'completed',
      skus_reset: result.skusReset,
      results:    result.results,
      message:    sku
          ? `Master de SKU "${sku}" resincronizado con la realidad de Shopify y Alegra.`
          : `Master de ${result.skusReset} SKUs resincronizado con la realidad de ambas plataformas.`,
    });
  } catch (err) {
    next(err);
  }
});

export default router;