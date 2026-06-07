import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../db/prisma';
import { verifyJwt, requireRole } from '../middlewares/auth';
import { productQuerySchema } from '../schemas/inventory.schemas';
import { NotFoundError, ValidationError } from '../../utils/errors';

const router = Router();

router.get('/', verifyJwt, requireRole('readonly'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = productQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError(JSON.stringify(parsed.error.flatten().fieldErrors));

    const { status, page, limit } = parsed.data;
    const skip = (page - 1) * limit;
    const where = status ? { status } : {};

    const [products, total] = await prisma.$transaction([
      prisma.productCatalog.findMany({ where, skip, take: limit, orderBy: { createdAt: 'desc' } }),
      prisma.productCatalog.count({ where }),
    ]);

    res.json({
      data: products.map((p: typeof products[number]) => ({
        sku:               p.sku,
        name:              p.lastKnownName,
        shopify_variant_id:p.shopifyVariantId,
        shopify_product_id:p.shopifyProductId,
        alegra_item_id:    p.alegraItemId,
        status:            p.status,
        price:             p.lastKnownPrice,
        cost:              p.lastKnownCost,
        created_at:        p.createdAt,
        updated_at:        p.updatedAt,
      })),
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:sku', verifyJwt, requireRole('readonly'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const product = await prisma.productCatalog.findUnique({
      where: { sku: req.params.sku },
      include: { inventory: true },
    });
    if (!product) throw new NotFoundError('Producto', req.params.sku);

    res.json({
      sku:               product.sku,
      name:              product.lastKnownName,
      shopify_variant_id:product.shopifyVariantId,
      shopify_product_id:product.shopifyProductId,
      alegra_item_id:    product.alegraItemId,
      status:            product.status,
      price:             product.lastKnownPrice,
      cost:              product.lastKnownCost,
      option1:           product.lastKnownOption1,
      option2:           product.lastKnownOption2,
      stock_global:      product.inventory?.stockGlobal ?? 0,
      created_at:        product.createdAt,
      updated_at:        product.updatedAt,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
