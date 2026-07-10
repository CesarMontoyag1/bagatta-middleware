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

  // ── JSON malformado (body-parser) ───────────────────────────────────────────
  // Un cliente mandando JSON inválido no es un bug del servidor — es un 400,
  // no un 500. Sin este caso, cualquier body mal formado (por error de
  // tipeo del cliente, o a propósito) generaba un "Unhandled error" 500,
  // lo cual es mala práctica (indica excepción no controlada) y no da al
  // cliente información útil para corregir su request.
  if (err instanceof SyntaxError && (err as SyntaxError & { type?: string }).type === 'entity.parse.failed') {
    logger.warn(`[${requestId}] 400 JSON inválido en el body de la petición`);
    res.status(400).json({
      error: {
        code:       'INVALID_JSON',
        message:    'El cuerpo de la petición no es JSON válido',
        request_id: requestId,
        timestamp,
      },
    });
    return;
  }

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