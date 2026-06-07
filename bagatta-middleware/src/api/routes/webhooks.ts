import { Router, Request, Response, NextFunction } from 'express';
import { verifyShopifyHmac } from '../middlewares/auth';
import { orchestrator } from '../../orchestrator/core';
import { auditService } from '../../services/audit';
import { logger } from '../../utils/logger';
import { ShopifyProduct } from '../../types';

const router = Router();

// Todos los endpoints de webhook usan HMAC en lugar de JWT
// Responden 200 OK ANTES de procesar para no superar el timeout de 5s de Shopify

// ── products/create ───────────────────────────────────────────────────────────
router.post('/shopify/products/create', verifyShopifyHmac, (req: Request, res: Response, _next: NextFunction) => {
  res.sendStatus(200); // Respuesta inmediata a Shopify

  const product = req.body as ShopifyProduct;
  orchestrator.handleProductCreate(product).catch((err) => {
    logger.error('Webhook products/create: error en procesamiento', err);
    auditService.createAlert({
      type:   'sku_missing',
      detail: `Error procesando webhook products/create para producto ${product.id}: ${err.message}`,
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
  // El ciclo de polling reconciliará el ajuste manual en el siguiente tick
  logger.info(`Webhook inventory_levels/update: item=${req.body.inventory_item_id}, available=${req.body.available}`);
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
