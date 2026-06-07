import express, { Request, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { env } from '../config/env';
import { requestIdMiddleware } from './middlewares/requestId';
import { apiRateLimiter } from './middlewares/rateLimit';
import { errorHandler } from './middlewares/errorHandler';

// Routes
import authRouter      from './routes/auth';
import statusRouter    from './routes/status';
import inventoryRouter from './routes/inventory';
import productsRouter  from './routes/products';
import auditRouter     from './routes/audit';
import syncRouter      from './routes/sync';
import alertsRouter    from './routes/alerts';
import configRouter    from './routes/config';
import webhooksRouter  from './routes/webhooks';

export function createApp(): express.Application {
  const app = express();

  // ── Trust proxy (Render, Vercel, etc.) ───────────────────────────────────
  app.set('trust proxy', 1);

  // ── Seguridad global ──────────────────────────────────────────────────────
  app.use(helmet({
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  }));

  app.use(cors({
    origin:      env.CORS_ALLOWED_ORIGIN,
    methods:     ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
    credentials: true,
  }));

  // ── Body parsing ──────────────────────────────────────────────────────────
  // Los webhooks necesitan el raw body para validar HMAC → guardarlo antes de parsear
  app.use(
    express.json({
      verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );

  // ── Middlewares globales ──────────────────────────────────────────────────
  app.use(requestIdMiddleware);
  app.use(apiRateLimiter);

  // ── Health check público (sin auth — para Render health checks) ───────────
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', ts: new Date().toISOString() });
  });

  // ── API Routes ────────────────────────────────────────────────────────────
  app.use('/api/v1/auth',      authRouter);
  app.use('/api/v1/status',    statusRouter);
  app.use('/api/v1/inventory', inventoryRouter);
  app.use('/api/v1/products',  productsRouter);
  app.use('/api/v1/audit-log', auditRouter);
  app.use('/api/v1/sync',      syncRouter);
  app.use('/api/v1/alerts',    alertsRouter);
  app.use('/api/v1/config',    configRouter);
  app.use('/api/v1/webhooks',  webhooksRouter);

  // ── 404 handler ───────────────────────────────────────────────────────────
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Ruta no encontrada', timestamp: new Date().toISOString() } });
  });

  // ── Error handler global ──────────────────────────────────────────────────
  app.use(errorHandler);

  return app;
}
