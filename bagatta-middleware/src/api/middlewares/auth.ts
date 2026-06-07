import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { UserRole } from '@prisma/client';
import { JWT_PUBLIC_KEY, env } from '../../config/env';
import { JwtPayload } from '../../types';
import { UnauthorizedError, ForbiddenError } from '../../utils/errors';

// ── JWT verification ──────────────────────────────────────────────────────────
export function verifyJwt(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  // SSE también acepta token como query param (EventSource no soporta headers)
  const token =
    (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null) ??
    (req.query.token as string | undefined) ??
    null;

  if (!token) {
    return next(new UnauthorizedError('Token no proporcionado'));
  }

  try {
    const payload = jwt.verify(token, JWT_PUBLIC_KEY, {
      algorithms: ['RS256'],
    }) as JwtPayload;

    req.user = payload;
    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return next(new UnauthorizedError('Token expirado'));
    }
    return next(new UnauthorizedError('Token inválido'));
  }
}

// ── RBAC ──────────────────────────────────────────────────────────────────────
const ROLE_HIERARCHY: Record<UserRole, number> = {
  readonly: 1,
  operator: 2,
  admin:    3,
  system:   4,
};

export function requireRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(new UnauthorizedError());
    }

    const userLevel = ROLE_HIERARCHY[req.user.role] ?? 0;
    const requiredLevel = Math.min(...roles.map((r) => ROLE_HIERARCHY[r]));

    if (userLevel < requiredLevel) {
      return next(new ForbiddenError());
    }

    next();
  };
}

// ── Shopify webhook HMAC validation ───────────────────────────────────────────
export function verifyShopifyHmac(req: Request, _res: Response, next: NextFunction): void {
  const hmacHeader = req.headers['x-shopify-hmac-sha256'] as string | undefined;

  if (!hmacHeader) {
    return next(new UnauthorizedError('Firma HMAC de Shopify ausente'));
  }

  // El body debe estar disponible como raw buffer (configurado en app.ts con verify)
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!rawBody) {
    return next(new UnauthorizedError('No se pudo leer el body para validar HMAC'));
  }

  const digest = crypto
    .createHmac('sha256', env.SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('base64');

  // Comparación en tiempo constante — previene timing attacks
  const digestBuffer = Buffer.from(digest, 'base64');
  const headerBuffer = Buffer.from(hmacHeader, 'base64');

  if (
    digestBuffer.length !== headerBuffer.length ||
    !crypto.timingSafeEqual(digestBuffer, headerBuffer)
  ) {
    return next(new UnauthorizedError('Firma HMAC de Shopify inválida'));
  }

  next();
}
