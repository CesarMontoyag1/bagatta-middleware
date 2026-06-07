import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../db/prisma';
import { verifyJwt, requireRole } from '../middlewares/auth';
import { orchestrator } from '../../orchestrator/core';
import { sseService } from '../../services/sse';

const router = Router();

router.get('/', verifyJwt, requireRole('readonly'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const state = await prisma.syncState.findUnique({ where: { id: 1 } });
    const totalSynced = await prisma.productCatalog.count({ where: { status: 'active' } });
    const activeAlerts = await prisma.alert.count({ where: { acknowledged: false } });

    const { isSyncing, isInCatchup } = orchestrator.syncingStatus;

    res.json({
      status:                  state?.status ?? 'unknown',
      last_successful_sync:    state?.lastSuccessfulSync,
      last_attempted_sync:     state?.lastAttemptedSync,
      consecutive_failures:    state?.consecutiveFailures ?? 0,
      error_detail:            state?.errorDetail ?? null,
      is_syncing:              isSyncing,
      is_in_catchup:           isInCatchup,
      total_synced_skus:       totalSynced,
      active_alerts:           activeAlerts,
      sse_clients_connected:   sseService.clientCount,
      uptime_seconds:          Math.floor(process.uptime()),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
