import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';

declare global {
  // Permite reusar la instancia en hot-reload de desarrollo
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

function createPrismaClient(): PrismaClient {
  const client = new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? [{ emit: 'event', level: 'query' }, 'warn', 'error']
        : ['warn', 'error'],
  });

  if (process.env.NODE_ENV === 'development') {
    // Log queries lentas (>500ms) en desarrollo
    (client as any).$on('query', (e: { duration: number; query: string }) => {
      if (e.duration > 500) {
        logger.warn(`Slow query (${e.duration}ms): ${e.query}`);
      }
    });
  }

  return client;
}

export const prisma: PrismaClient =
  global.__prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  global.__prisma = prisma;
}

export async function connectDB(): Promise<void> {
  try {
    await prisma.$connect();
    logger.info('✅  Base de datos conectada (Supabase)');
  } catch (error) {
    logger.error('❌  Error conectando a la base de datos:', error);
    throw error;
  }
}

export async function disconnectDB(): Promise<void> {
  await prisma.$disconnect();
  logger.info('Base de datos desconectada');
}
