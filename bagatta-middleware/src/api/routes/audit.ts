import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../db/prisma';
import { verifyJwt, requireRole } from '../middlewares/auth';
import { auditLogQuerySchema } from '../schemas/inventory.schemas';
import { NotFoundError, ValidationError } from '../../utils/errors';

const router = Router();

// ── GET /audit-log ────────────────────────────────────────────────────────────
router.get('/', verifyJwt, requireRole('readonly'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = auditLogQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError(JSON.stringify(parsed.error.flatten().fieldErrors));

    const { sku, origin, field, from, to, alert, page, limit } = parsed.data;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};
    if (sku)    where.sku          = { contains: sku, mode: 'insensitive' };
    if (origin) where.origin       = origin;
    if (field)  where.fieldChanged = field;
    if (alert !== undefined) where.alertTriggered = alert;

    if (from || to) {
      where.createdAt = {
        ...(from && { gte: new Date(from) }),
        ...(to   && { lte: new Date(to) }),
      };
    }

    const [logs, total] = await prisma.$transaction([
      prisma.auditLog.findMany({
        where,
        skip,
        take:    limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.auditLog.count({ where }),
    ]);

    res.json({
      data: logs.map((l: typeof logs[number]) => ({
        id:               l.id,
        sku:              l.sku,
        field_changed:    l.fieldChanged,
        old_value:        l.oldValue,
        new_value:        l.newValue,
        origin:           l.origin,
        source_event_ref: l.sourceEventRef,
        alert_triggered:  l.alertTriggered,
        idempotency_key:  l.idempotencyKey,
        created_at:       l.createdAt,
      })),
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /audit-log/:id ────────────────────────────────────────────────────────
router.get('/:id', verifyJwt, requireRole('readonly'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const log = await prisma.auditLog.findUnique({ where: { id: req.params.id } });
    if (!log) throw new NotFoundError('Entrada de audit log');

    res.json({
      id:               log.id,
      sku:              log.sku,
      field_changed:    log.fieldChanged,
      old_value:        log.oldValue,
      new_value:        log.newValue,
      origin:           log.origin,
      source_event_ref: log.sourceEventRef,
      alert_triggered:  log.alertTriggered,
      idempotency_key:  log.idempotencyKey,
      created_at:       log.createdAt,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
