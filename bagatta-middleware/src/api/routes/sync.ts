import { Router, Request, Response, NextFunction } from 'express';
import { verifyJwt, requireRole } from '../middlewares/auth';
import { orchestrator } from '../../orchestrator/core';
import { sseService } from '../../services/sse';
import { auditService } from '../../services/audit';
import { prisma } from '../../db/prisma';
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

export default router;
