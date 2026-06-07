import { Router, Request, Response, NextFunction } from 'express';
import { verifyJwt, requireRole } from '../middlewares/auth';
import { configPatchSchema } from '../schemas/config.schemas';
import { auditService } from '../../services/audit';
import { ValidationError } from '../../utils/errors';
import { env } from '../../config/env';
import { buildIdempotencyKey } from '../../utils/idempotency';

const router = Router();

// Config en memoria — en producción podría persistirse en BD
// pero para este MVP las variables de entorno son la fuente de verdad.
let runtimeConfig = {
  polling_interval_seconds:         env.POLLING_INTERVAL_SECONDS,
  catchup_threshold_minutes:        env.CATCHUP_THRESHOLD_MINUTES,
  downtime_alert_threshold_minutes: env.DOWNTIME_ALERT_THRESHOLD_MINUTES,
  rate_limit_max_requests:          env.RATE_LIMIT_MAX_REQUESTS,
};

router.get('/', verifyJwt, requireRole('admin'), (_req: Request, res: Response) => {
  res.json(runtimeConfig);
});

router.patch('/', verifyJwt, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idempKey = req.headers['idempotency-key'] as string | undefined;
    if (!idempKey) {
      throw new ValidationError('Header Idempotency-Key requerido');
    }

    const parsed = configPatchSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(JSON.stringify(parsed.error.flatten().fieldErrors));

    const changes = parsed.data;
    const oldConfig = { ...runtimeConfig };

    runtimeConfig = { ...runtimeConfig, ...changes };

    // Audit log del cambio de config
    for (const [key, value] of Object.entries(changes)) {
      await auditService.log({
        idempotencyKey: buildIdempotencyKey('manual_admin', idempKey, `config_${key}`),
        sku:            'SYSTEM',
        fieldChanged:   'status', // campo genérico para config
        oldValue:       String((oldConfig as Record<string, unknown>)[key]),
        newValue:       String(value),
        origin:         'manual_admin',
        sourceEventRef: `config_patch_${req.user!.sub}`,
      });
    }

    res.json({ message: 'Configuración actualizada', config: runtimeConfig });
  } catch (err) {
    next(err);
  }
});

export default router;
