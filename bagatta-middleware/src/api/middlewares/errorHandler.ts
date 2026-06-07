import { Request, Response, NextFunction } from 'express';
import { AppError } from '../../utils/errors';
import { logger } from '../../utils/logger';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  const requestId = req.requestId ?? 'unknown';
  const timestamp = new Date().toISOString();

  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      logger.error(`[${requestId}] ${err.code}: ${err.message}`, { detail: err.detail });
    } else {
      logger.warn(`[${requestId}] ${err.statusCode} ${err.code}: ${err.message}`);
    }

    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.detail && { detail: err.detail }),
        ...(err.sku && { sku: err.sku }),
        request_id: requestId,
        timestamp,
      },
    });
    return;
  }

  // Error inesperado — nunca exponer detalles al cliente
  logger.error(`[${requestId}] Unhandled error: ${err.message}`, { stack: err.stack });
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Error interno del servidor',
      request_id: requestId,
      timestamp,
    },
  });
}
