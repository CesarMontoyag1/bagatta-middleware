import './config/env'; // Valida variables de entorno PRIMERO — falla rápido si faltan
import { createApp } from './api/app';
import { connectDB, disconnectDB } from './db/prisma';
import { startScheduler } from './cron/scheduler';
import { logger } from './utils/logger';
import { env } from './config/env';
import { bootstrapAlegraIds } from './services/alegraBootstrap';

async function bootstrap(): Promise<void> {
  logger.info('🚀  Bagatta Middleware arrancando...');
  logger.info(`   Entorno: ${env.NODE_ENV}`);

  // ── 1. Conectar base de datos ──────────────────────────────────────────────
  await connectDB();

  // ── 2. Resolver IDs de Alegra automáticamente ─────────────────────────────
  // El sistema busca la categoría y la bodega por nombre en la API de Alegra.
  // No se necesita conocer los IDs de antemano ni hacer curls manuales.
  // Si los nombres no coinciden, el proceso termina con un mensaje claro.
  await bootstrapAlegraIds(
      env.ALEGRA_SYNC_CATEGORY_NAME,  // default: 'Tienda Virtual y Física'
      env.ALEGRA_WAREHOUSE_NAME,       // default: 'Principal'
  );

  // ── 3. Crear app Express ───────────────────────────────────────────────────
  const app = createApp();

  // ── 4. Iniciar servidor HTTP ───────────────────────────────────────────────
  const server = app.listen(env.PORT, () => {
    logger.info(`✅  Servidor escuchando en http://localhost:${env.PORT}`);
    logger.info(`   Health: http://localhost:${env.PORT}/health`);
    logger.info(`   Status: http://localhost:${env.PORT}/api/v1/status`);
  });

  // ── 5. Iniciar scheduler (polling + heartbeat + purge + self-ping) ─────────
  startScheduler();

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    logger.info(`\n${signal} recibido — apagando servidor...`);

    server.close(async () => {
      await disconnectDB();
      logger.info('Servidor apagado correctamente. Hasta luego 👋');
      process.exit(0);
    });

    // Forzar salida tras 10s si algo no cierra correctamente
    setTimeout(() => {
      logger.error('Forzando salida tras timeout de shutdown');
      process.exit(1);
    }, 10_000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('unhandledRejection:', { reason, promise });
  });

  process.on('uncaughtException', (err) => {
    logger.error('uncaughtException — apagando:', err);
    process.exit(1);
  });
}

bootstrap().catch((err) => {
  logger.error('Error fatal en bootstrap:', err);
  process.exit(1);
});