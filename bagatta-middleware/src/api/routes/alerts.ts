import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../db/prisma';
import { verifyJwt, requireRole } from '../middlewares/auth';
import { NotFoundError } from '../../utils/errors';

const router = Router();

router.get('/', verifyJwt, requireRole('readonly'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const alerts = await prisma.alert.findMany({
      where: { acknowledged: false },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: alerts, total: alerts.length });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/acknowledge', verifyJwt, requireRole('operator'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const alert = await prisma.alert.findUnique({ where: { id: req.params.id } });
    if (!alert) throw new NotFoundError('Alerta');

    const updated = await prisma.alert.update({
      where: { id: req.params.id },
      data: {
        acknowledged:   true,
        acknowledgedBy: req.user!.sub,
        acknowledgedAt: new Date(),
      },
    });

    res.json({ message: 'Alerta reconocida', alert: updated });
  } catch (err) {
    next(err);
  }
});

export default router;
