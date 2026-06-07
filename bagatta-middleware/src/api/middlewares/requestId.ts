import { Request, Response, NextFunction } from 'express';
import { generateRequestId } from '../../utils/idempotency';

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const id = generateRequestId();
  req.requestId = id;
  res.setHeader('X-Request-ID', id);
  next();
}
