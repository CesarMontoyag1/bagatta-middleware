import cron from 'node-cron';
import axios from 'axios';
import { orchestrator } from '../orchestrator/core';
import { sseService } from '../services/sse';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { env } from '../config/env';

export function startScheduler(): void {
  // ── 1. Polling principal — cada 10 segundos ───────────────────────────────
  // node-cron mínimo es 1 minuto. Usamos setInterval para frecuencias menores.
  const intervalMs = env.POLLING_INTERVAL_SECONDS * 1000;
  setInterval(async () => {
    try {
      const result = await orchestrator.runPollingCycle();
      if (result.errors.length > 0) {
        logger.warn(`Ciclo completado con ${result.errors.length} errores:`, result.errors);
      } else {
        logger.debug(`Ciclo OK: ${result.skusChecked} SKUs, ${result.deltasApplied} deltas, ${result.durationMs}ms`);
      }
    } catch (err) {
      logger.error('Error crítico en ciclo de polling:', err);
    }
  }, intervalMs);

  logger.info(`⏱  Polling iniciado: cada ${env.POLLING_INTERVAL_SECONDS}s`);

  // ── 1b. Sincronización rápida — SOLO cambios de Alegra ────────────────────
  // Independiente del polling principal. Detecta ventas/ajustes manuales
  // hechos directamente en Alegra en segundos, sin esperar al ciclo lento.
  const fastSyncIntervalMs = env.ALEGRA_FAST_SYNC_INTERVAL_SECONDS * 1000;
  setInterval(async () => {
    try {
      const result = await orchestrator.fastAlegraSync();
      if (result.errors.length > 0) {
        logger.warn(`FastAlegraSync completado con ${result.errors.length} errores:`, result.errors);
      } else if (result.changed > 0) {
        logger.info(`FastAlegraSync: ${result.changed}/${result.checked} SKUs actualizados`);
      }
      // Sin cambios: no loguea nada, para no generar ruido cada 30s
    } catch (err) {
      logger.error('Error crítico en FastAlegraSync:', err);
    }
  }, fastSyncIntervalMs);

  logger.info(`⚡  Sincronización rápida de Alegra iniciada: cada ${env.ALEGRA_FAST_SYNC_INTERVAL_SECONDS}s`);

  // ── 1c. Sincronización rápida — SOLO cambios de Shopify ───────────────────
  // Simétrico al job de Alegra. No depende de que los webhooks de Shopify
  // estén registrados — pregunta activamente por el stock real en bloque.
  const shopifyFastSyncIntervalMs = env.SHOPIFY_FAST_SYNC_INTERVAL_SECONDS * 1000;
  setInterval(async () => {
    try {
      const result = await orchestrator.fastShopifySync();
      if (result.errors.length > 0) {
        logger.warn(`FastShopifySync completado con ${result.errors.length} errores:`, result.errors);
      } else if (result.changed > 0) {
        logger.info(`FastShopifySync: ${result.changed}/${result.checked} SKUs actualizados`);
      }
    } catch (err) {
      logger.error('Error crítico en FastShopifySync:', err);
    }
  }, shopifyFastSyncIntervalMs);

  logger.info(`⚡  Sincronización rápida de Shopify iniciada: cada ${env.SHOPIFY_FAST_SYNC_INTERVAL_SECONDS}s`);

  // ── 2. Heartbeat SSE — cada 30 segundos ──────────────────────────────────
  setInterval(() => {
    sseService.heartbeat();
  }, 30_000);

  // ── 3. Purge job — diariamente a las 3:00 AM ──────────────────────────────
  cron.schedule('0 3 * * *', async () => {
    logger.info('PurgeJob: iniciando limpieza de audit_log > 30 días...');
    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 30);

      const result = await prisma.auditLog.deleteMany({
        where: { createdAt: { lt: cutoff } },
      });

      await prisma.purgeHistory.create({
        data: {
          tableName:    'audit_log',
          rowsAffected: result.count,
          cutoffDate:   cutoff,
          status:       'success',
        },
      });

      // Purgar también login_attempts > 7 días
      const loginCutoff = new Date();
      loginCutoff.setDate(loginCutoff.getDate() - 7);
      await prisma.loginAttempt.deleteMany({ where: { createdAt: { lt: loginCutoff } } });

      // Purgar refresh_tokens expirados
      await prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: new Date() } } });

      // Purgar purge_history > 90 días
      const purgeCutoff = new Date();
      purgeCutoff.setDate(purgeCutoff.getDate() - 90);
      await prisma.purgeHistory.deleteMany({ where: { ranAt: { lt: purgeCutoff } } });

      logger.info(`PurgeJob: ${result.count} filas de audit_log eliminadas`);

    } catch (err) {
      logger.error('PurgeJob: error durante limpieza', err);
      await prisma.purgeHistory.create({
        data: {
          tableName:    'audit_log',
          rowsAffected: 0,
          cutoffDate:   new Date(),
          status:       'failed',
          errorDetail:  (err as Error).message,
        },
      });
    }
  });

  // ── 4. Self-ping — cada N minutos (evitar sleep en Render free tier) ──────
  if (env.NODE_ENV === 'production' && env.SELF_URL) {
    const pingIntervalMs = env.SELF_PING_INTERVAL_MINUTES * 60_000;
    setInterval(async () => {
      try {
        await axios.get(`${env.SELF_URL}/api/v1/status`, { timeout: 5000 });
        logger.debug('Self-ping OK');
      } catch {
        logger.warn('Self-ping falló');
      }
    }, pingIntervalMs);

    logger.info(`📡  Self-ping cada ${env.SELF_PING_INTERVAL_MINUTES} min`);
  }

  logger.info('✅  Scheduler iniciado');
}