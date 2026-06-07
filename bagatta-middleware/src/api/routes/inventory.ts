import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../db/prisma';
import { verifyJwt, requireRole } from '../middlewares/auth';
import { inventoryQuerySchema } from '../schemas/inventory.schemas';
import { NotFoundError, ValidationError } from '../../utils/errors';

const router = Router();

// ── GET /inventory ────────────────────────────────────────────────────────────
router.get('/', verifyJwt, requireRole('readonly'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = inventoryQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError(JSON.stringify(parsed.error.flatten().fieldErrors));

    const { sku, status, conflict, page, limit } = parsed.data;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};
    if (sku)    where.sku    = { contains: sku, mode: 'insensitive' };
    if (status) where.status = status;

    // Filtro de conflicto: SKUs donde stock_global != stock_alegra_last o != stock_shopify_last
    // Se hace en memoria por simplicidad (el volumen es acotado)
    const [catalogItems, total] = await prisma.$transaction([
      prisma.productCatalog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { updatedAt: 'desc' },
        include: { inventory: true },
      }),
      prisma.productCatalog.count({ where }),
    ]);

    let filtered = catalogItems;
    if (conflict) {
      filtered = catalogItems.filter(
        (c: typeof catalogItems[number]) =>
          c.inventory &&
          (c.inventory.stockGlobal !== c.inventory.stockAlegraLast ||
            c.inventory.stockGlobal !== c.inventory.stockShopifyLast),
      );
    }

    const data = filtered.map((c: typeof catalogItems[number]) => ({
      sku:                  c.sku,
      stock_global:         c.inventory?.stockGlobal ?? 0,
      stock_alegra_last:    c.inventory?.stockAlegraLast ?? 0,
      stock_shopify_last:   c.inventory?.stockShopifyLast ?? 0,
      last_updated:         c.inventory?.lastUpdated,
      last_updated_by:      c.inventory?.lastUpdatedBy,
      catalog: {
        name:              c.lastKnownName,
        alegra_item_id:    c.alegraItemId,
        shopify_variant_id:c.shopifyVariantId,
        status:            c.status,
        price:             c.lastKnownPrice,
        cost:              c.lastKnownCost,
      },
    }));

    res.json({
      data,
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /inventory/:sku ───────────────────────────────────────────────────────
router.get('/:sku', verifyJwt, requireRole('readonly'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sku = req.params.sku;

    const catalog = await prisma.productCatalog.findUnique({
      where: { sku },
      include: { inventory: true },
    });

    if (!catalog) throw new NotFoundError('SKU', sku);

    res.json({
      sku:                catalog.sku,
      stock_global:       catalog.inventory?.stockGlobal ?? 0,
      stock_alegra_last:  catalog.inventory?.stockAlegraLast ?? 0,
      stock_shopify_last: catalog.inventory?.stockShopifyLast ?? 0,
      last_updated:       catalog.inventory?.lastUpdated,
      last_updated_by:    catalog.inventory?.lastUpdatedBy,
      catalog: {
        name:               catalog.lastKnownName,
        alegra_item_id:     catalog.alegraItemId,
        shopify_variant_id: catalog.shopifyVariantId,
        shopify_product_id: catalog.shopifyProductId,
        status:             catalog.status,
        price:              catalog.lastKnownPrice,
        cost:               catalog.lastKnownCost,
        option1:            catalog.lastKnownOption1,
        option2:            catalog.lastKnownOption2,
        created_at:         catalog.createdAt,
        updated_at:         catalog.updatedAt,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
