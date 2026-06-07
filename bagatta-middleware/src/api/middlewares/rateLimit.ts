import rateLimit from 'express-rate-limit';
import { env } from '../../config/env';
import { Request, Response } from 'express';

function rateLimitHandler(_req: Request, res: Response): void {
  res.status(429).json({
    error: {
      code: 'RATE_LIMITED',
      message: 'Demasiadas solicitudes. Intenta más tarde.',
      timestamp: new Date().toISOString(),
    },
  });
}

// ── General API rate limit ────────────────────────────────────────────────────
export const apiRateLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

// ── Auth endpoints (stricter) ─────────────────────────────────────────────────
export const authRateLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});
