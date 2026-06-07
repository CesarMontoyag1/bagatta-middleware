/**
 * Seed inicial — crea la fila singleton de sync_state y un usuario admin.
 * Ejecutar con: npm run db:seed
 * Es idempotente: puede correr múltiples veces sin efecto adverso.
 */
import bcrypt from 'bcrypt';
import { prisma, connectDB, disconnectDB } from './prisma';
import { logger } from '../utils/logger';

const BCRYPT_ROUNDS = 12;

async function seed(): Promise<void> {
  await connectDB();

  // ── 1. sync_state singleton ──────────────────────────────────────────────
  await prisma.syncState.upsert({
    where:  { id: 1 },
    update: {},
    create: { id: 1, status: 'idle', consecutiveFailures: 0 },
  });
  logger.info('✅  sync_state singleton creado/verificado');

  // ── 2. Usuario admin inicial ──────────────────────────────────────────────
  const adminEmail    = process.env.SEED_ADMIN_EMAIL    ?? 'admin@bagatta.co';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;

  if (!adminPassword) {
    logger.warn('⚠️   SEED_ADMIN_PASSWORD no definida. Saltando creación de usuario admin.');
    logger.warn('     Define SEED_ADMIN_PASSWORD en .env y vuelve a ejecutar db:seed');
  } else {
    if (adminPassword.length < 12) {
      logger.error('❌  SEED_ADMIN_PASSWORD debe tener mínimo 12 caracteres');
      process.exit(1);
    }

    // Hash real con bcrypt desde el primer momento — sin hashes temporales
    const passwordHash = await bcrypt.hash(adminPassword, BCRYPT_ROUNDS);

    await prisma.user.upsert({
      where:  { email: adminEmail },
      update: {}, // No sobreescribir si ya existe (protege la contraseña actual)
      create: {
        email: adminEmail,
        passwordHash,
        role:     'admin',
        isActive: true,
      },
    });
    logger.info(`✅  Usuario admin creado: ${adminEmail}`);
  }

  await disconnectDB();
  logger.info('🌱  Seed completado');
}

seed().catch((error) => {
  logger.error('❌  Error en seed:', error);
  process.exit(1);
});