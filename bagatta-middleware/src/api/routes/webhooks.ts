import { Router, Request, Response, NextFunction } from 'express';
import { verifyShopifyHmac } from '../middlewares/auth';
import { orchestrator } from '../../orchestrator/core';
import { auditService } from '../../services/audit';
import { logger } from '../../utils/logger';
import { ShopifyProduct } from '../../types';
import { getAlegraIds } from '../../services/alegraBootstrap';
import { prisma } from '../../db/prisma';

const router = Router();

// Todos los endpoints de webhook usan HMAC en lugar de JWT
// Responden 200 OK ANTES de procesar para no superar el timeout de 5s de Shopify

/**
 * Verifica si el sistema está listo para procesar webhooks.
 * Retorna false si Alegra Bootstrap no terminó (arranque muy rápido tras deploy).
 */
function isSystemReady(): boolean {
  try {
    getAlegraIds(); // Lanza si no está listo
    return true;
  } catch {
    return false;
  }
}

// ── products/create ───────────────────────────────────────────────────────────
router.post('/shopify/products/create', verifyShopifyHmac, (req: Request, res: Response, _next: NextFunction) => {
  res.sendStatus(200); // Respuesta inmediata a Shopify

  const product = req.body as ShopifyProduct;

  // Guarda de arranque: si el sistema no terminó el bootstrap, loguear y salir.
  // Shopify reintentará el webhook — en el siguiente intento el bootstrap ya estará listo.
  if (!isSystemReady()) {
    logger.warn(
        `Webhook products/create recibido para "${product.title}" (id=${product.id}) ` +
        `pero el sistema aún está iniciando (Bootstrap de Alegra pendiente). ` +
        `Shopify reintentará automáticamente. Si el problema persiste, usa POST /api/v1/sync/ingest-product/${product.id}`,
    );
    auditService.createAlert({
      type:   'sku_missing',
      detail: `Webhook products/create para "${product.title}" (id=${product.id}) ` +
          `recibido durante el arranque del servidor antes de que el Bootstrap de Alegra ` +
          `estuviera listo. Shopify reintentará el webhook. Si no se sincroniza en los ` +
          `próximos minutos, usa el endpoint manual: POST /api/v1/sync/ingest-product/${product.id}`,
    }).catch(() => {});
    return;
  }

  orchestrator.handleProductCreate(product).catch((err) => {
    logger.error('Webhook products/create: error en procesamiento', err);
    auditService.createAlert({
      type:   'sku_missing',
      detail: `Error procesando webhook products/create para producto "${product.title}" ` +
          `(id=${product.id}): ${(err as Error).message}. ` +
          `Usa POST /api/v1/sync/ingest-product/${product.id} para recuperarlo manualmente.`,
    }).catch(() => {});
  });
});

// ── products/update ───────────────────────────────────────────────────────────
router.post('/shopify/products/update', verifyShopifyHmac, (req: Request, res: Response, _next: NextFunction) => {
  res.sendStatus(200);

  const product = req.body as ShopifyProduct;
  orchestrator.handleProductUpdate(product).catch((err) => {
    logger.error('Webhook products/update: error en procesamiento', err);
  });
});

// ── products/delete ───────────────────────────────────────────────────────────
router.post('/shopify/products/delete', verifyShopifyHmac, (req: Request, res: Response, _next: NextFunction) => {
  res.sendStatus(200);

  const productId = String(req.body.id);
  orchestrator.handleProductDelete(productId).catch((err) => {
    logger.error('Webhook products/delete: error en procesamiento', err);
  });
});

// ── orders/create ─────────────────────────────────────────────────────────────
// Usamos este webhook para registro anticipado.
// El stock se reconcilia en el ciclo de polling (no aquí) para evitar race conditions.
router.post('/shopify/orders/create', verifyShopifyHmac, (req: Request, res: Response, _next: NextFunction) => {
  res.sendStatus(200);

  const order = req.body;
  logger.info(`Webhook orders/create recibido: ${order.name} (id=${order.id}), ${order.line_items?.length ?? 0} items`);
  // El polling detectará el delta en el siguiente ciclo de 10s
});

// ── inventory_levels/update ───────────────────────────────────────────────────
router.post('/shopify/inventory_levels/update', verifyShopifyHmac, (req: Request, res: Response, _next: NextFunction) => {
  res.sendStatus(200);

  const inventoryItemId = String(req.body.inventory_item_id);
  logger.info(`Webhook inventory_levels/update: item=${inventoryItemId}, available=${req.body.available}`);

  // ── Reconciliación dirigida e inmediata (no esperar al ciclo de polling) ──
  // Antes: este webhook solo logueaba, y el ajuste real de stock esperaba al
  // siguiente ciclo completo (que recorre TODO el catálogo activo, cada vez
  // más lento a medida que crece). Ahora: buscamos el SKU exacto afectado por
  // shopifyInventoryItemId (un solo SELECT, sin llamar a Shopify) y lo
  // reconciliamos ya mismo — el ciclo de polling pasa a ser solo la red de
  // seguridad para lo que se le escape a este webhook, no el camino principal.
  prisma.productCatalog
      .findUnique({ where: { shopifyInventoryItemId: inventoryItemId } })
      .then(async (entry: { sku: string; status: string } | null) => {
        if (!entry) {
          // Puede pasar con productos creados antes del backfill de
          // shopifyInventoryItemId, o si aún no completó su primer ciclo de
          // reconciliación. El polling normal lo cubre mientras tanto.
          logger.warn(
              `inventory_levels/update: no se encontró SKU para inventory_item_id=${inventoryItemId} ` +
              `(catálogo sin backfill todavía) — el polling lo cubrirá en su próximo ciclo`,
          );
          return;
        }
        if (entry.status !== 'active') return;

        try {
          await orchestrator.forceSyncSku(entry.sku);
          logger.info(`SKU ${entry.sku} reconciliado al instante por webhook de inventario`);
        } catch (err) {
          logger.error(
              `Error reconciliando SKU ${entry.sku} desde webhook de inventario: ${(err as Error).message}`,
          );
        }
      })
      .catch((err: Error) => {
        logger.error(`Error buscando catálogo para inventory_item_id=${inventoryItemId}: ${err.message}`);
      });
});

// ── app/uninstalled ───────────────────────────────────────────────────────────
router.post('/shopify/app/uninstalled', verifyShopifyHmac, (_req: Request, res: Response, _next: NextFunction) => {
  res.sendStatus(200);
  logger.error('⚠️  CRÍTICO: App de Shopify desinstalada!');
  auditService.createAlert({
    type:   'variant_archived',
    detail: 'La app de Shopify fue desinstalada. La sincronización está detenida. Reinstala y verifica webhooks.',
  }).catch(() => {});
});

export default router;