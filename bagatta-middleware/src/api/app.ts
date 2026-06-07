import express, { Request, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { env } from '../config/env';
import { requestIdMiddleware } from './middlewares/requestId';
import { apiRateLimiter } from './middlewares/rateLimit';
import { errorHandler } from './middlewares/errorHandler';

// Routes
import authRouter       from './routes/auth';
import statusRouter     from './routes/status';
import inventoryRouter  from './routes/inventory';
import productsRouter   from './routes/products';
import auditRouter      from './routes/audit';
import syncRouter       from './routes/sync';
import alertsRouter     from './routes/alerts';
import configRouter     from './routes/config';
import webhooksRouter   from './routes/webhooks';
import shopifySetupRouter from './routes/shopifySetup';

export function createApp(): express.Application {
  const app = express();

  app.set('trust proxy', 1);

  app.use(helmet({
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  }));

  app.use(cors({
    origin:         env.CORS_ALLOWED_ORIGIN,
    methods:        ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
    credentials:    true,
  }));

  // Los webhooks necesitan el raw body para validar HMAC
  app.use(
      express.json({
        verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
          req.rawBody = buf;
        },
      }),
  );

  app.use(requestIdMiddleware);
  app.use(apiRateLimiter);

  // ── Health check público ──────────────────────────────────────────────────
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', ts: new Date().toISOString() });
  });

  // ── Setup (solo en development o cuando falta el token) ───────────────────
  // GET /setup/shopify/install  → inicia el OAuth de Shopify
  // GET /setup/shopify/callback → recibe el code y guarda el shpat_
  // GET /setup/shopify/verify   → verifica que el token actual es válido
  app.use('/setup', shopifySetupRouter);

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

  // ── 404 ───────────────────────────────────────────────────────────────────
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'Ruta no encontrada', timestamp: new Date().toISOString() },
    });
  });

  app.use(errorHandler);

  return app;
}