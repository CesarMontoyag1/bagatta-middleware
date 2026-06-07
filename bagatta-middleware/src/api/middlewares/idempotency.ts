import { Request, Response, NextFunction } from 'express';
import { prisma } from '../../db/prisma';
import { ConflictError } from '../../utils/errors';

/**
 * Middleware de idempotencia para endpoints de escritura.
 * Lee el header Idempotency-Key y verifica si ya fue procesado.
 * Si ya existe en audit_log → 409 Conflict.
 * Si no existe → permite continuar.
 */
export async function idempotencyCheck(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const key = req.headers['idempotency-key'] as string | undefined;

  if (!key) {
    return next(new ConflictError('Header Idempotency-Key requerido para operaciones de escritura'));
  }

  if (key.length > 128) {
    return next(new ConflictError('Idempotency-Key excede 128 caracteres'));
  }

  const existing = await prisma.auditLog.findUnique({
    where: { idempotencyKey: key },
    select: { id: true, createdAt: true },
  });

  if (existing) {
    next(
      new ConflictError(
        `Operación ya procesada con esta Idempotency-Key (id: ${existing.id}, en: ${existing.createdAt.toISOString()})`,
      ),
    );
    return;
  }

  // Attachar la key al request para que el handler la use al insertar en audit_log
  (req as Request & { idempotencyKey: string }).idempotencyKey = key;
  next();
}
