import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { UserRole } from '@prisma/client';
import { JWT_PUBLIC_KEY, env } from '../../config/env';
import { JwtPayload } from '../../types';
import { UnauthorizedError, ForbiddenError } from '../../utils/errors';
import { prisma } from '../../db/prisma';

// ── JWT verification (solo header Authorization) ───────────────────────────────
function verifyToken(token: string | null): JwtPayload {
  if (!token) {
    throw new UnauthorizedError('Token no proporcionado');
  }

  try {
    return jwt.verify(token, JWT_PUBLIC_KEY, { algorithms: ['RS256'] }) as JwtPayload;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw new UnauthorizedError('Token expirado');
    }
    throw new UnauthorizedError('Token inválido');
  }
}

export function verifyJwt(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  try {
    req.user = verifyToken(token);
    next();
  } catch (err) {
    next(err);
  }
}

// ── JWT verification para SSE ───────────────────────────────────────────────
// EventSource no soporta headers personalizados, así que SOLO este endpoint
// (GET /sync/stream) acepta el token como query param. No usar esta función
// en ninguna otra ruta: un token en la URL puede quedar expuesto en logs del
// servidor, historial del navegador o en el header Referer.
export function verifyJwtSSE(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const token =
      (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null) ??
      (req.query.token as string | undefined) ??
      null;

  try {
    req.user = verifyToken(token);
    next();
  } catch (err) {
    next(err);
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
    // Registrar intento sin firma — puede ser un ataque o un misconfiguration
    prisma.alert.create({
      data: {
        type:   'webhook_hmac_failure',
        detail: `Webhook recibido en ${req.path} sin header X-Shopify-Hmac-Sha256. ` +
            `IP: ${req.ip}. Posible petición no autorizada o mal configurada.`,
      },
    }).catch(() => {}); // fire-and-forget
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
    // HMAC inválido: el secreto en .env no coincide con el de Shopify.
    // Registrar alerta visible en el dashboard para que el operador lo detecte.
    prisma.alert.create({
      data: {
        type:   'webhook_hmac_failure',
        detail: `HMAC inválido en webhook ${req.path}. ` +
            `El SHOPIFY_WEBHOOK_SECRET del middleware no coincide con el secreto ` +
            `configurado en Shopify → Settings → Notifications → Webhooks. ` +
            `Los webhooks de Shopify están siendo rechazados — los productos ` +
            `creados en Shopify NO se sincronizan con Alegra hasta que se corrija.`,
      },
    }).catch(() => {}); // fire-and-forget — no bloquear el rechazo
    return next(new UnauthorizedError('Firma HMAC de Shopify inválida'));
  }

  next();
}