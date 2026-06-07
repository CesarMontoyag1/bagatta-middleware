import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT:     z.coerce.number().default(3000),

  // ── Base de datos ──────────────────────────────────────────────────────────
  DATABASE_URL: z.string().min(1, 'DATABASE_URL es obligatoria'),
  DIRECT_URL:   z.string().min(1, 'DIRECT_URL es obligatoria'),

  // ── JWT (llaves en base64 para evitar problemas con saltos de línea en .env)
  JWT_PRIVATE_KEY_B64:   z.string().min(1, 'JWT_PRIVATE_KEY_B64 es obligatoria'),
  JWT_PUBLIC_KEY_B64:    z.string().min(1, 'JWT_PUBLIC_KEY_B64 es obligatoria'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('8h'),
  SYSTEM_INTERNAL_SECRET: z.string().min(32, 'SYSTEM_INTERNAL_SECRET debe tener al menos 32 caracteres'),

  // ── Shopify ────────────────────────────────────────────────────────────────
  SHOPIFY_SHOP_DOMAIN:    z.string().min(1, 'SHOPIFY_SHOP_DOMAIN es obligatoria'),
  SHOPIFY_ACCESS_TOKEN:   z.string().min(1, 'SHOPIFY_ACCESS_TOKEN es obligatoria'),
  SHOPIFY_API_VERSION:    z.string().default('2024-04'),
  SHOPIFY_WEBHOOK_SECRET: z.string().min(1, 'SHOPIFY_WEBHOOK_SECRET es obligatoria'),
  SHOPIFY_LOCATION_ID:    z.string().min(1, 'SHOPIFY_LOCATION_ID es obligatoria'),

  // ── Alegra ─────────────────────────────────────────────────────────────────
  ALEGRA_USER_EMAIL:   z.string().email('ALEGRA_USER_EMAIL debe ser un email válido'),
  ALEGRA_API_TOKEN:    z.string().min(1, 'ALEGRA_API_TOKEN es obligatoria'),

  // Nombres legibles — los IDs se resuelven automáticamente al arrancar
  // No requieren curl ni búsqueda manual en Alegra
  ALEGRA_SYNC_CATEGORY_NAME: z.string().default('Tienda Virtual y Física'),
  ALEGRA_WAREHOUSE_NAME:     z.string().default('Principal'),
  ALEGRA_UNIT_OF_MEASURE:    z.string().default('Unidad'),

  // ── Sincronización ─────────────────────────────────────────────────────────
  POLLING_INTERVAL_SECONDS:          z.coerce.number().default(10),
  CATCHUP_THRESHOLD_MINUTES:         z.coerce.number().default(2),
  DOWNTIME_ALERT_THRESHOLD_MINUTES:  z.coerce.number().default(5),
  SELF_PING_INTERVAL_MINUTES:        z.coerce.number().default(10),

  // ── Rate limiting ──────────────────────────────────────────────────────────
  RATE_LIMIT_WINDOW_MS:     z.coerce.number().default(60000),
  RATE_LIMIT_MAX_REQUESTS:  z.coerce.number().default(100),
  AUTH_RATE_LIMIT_MAX:      z.coerce.number().default(10),

  // ── CORS y URLs ────────────────────────────────────────────────────────────
  CORS_ALLOWED_ORIGIN: z.string().default('http://localhost:5173'),
  SELF_URL:            z.string().default('http://localhost:3000'),

  // ── Seed ──────────────────────────────────────────────────────────────────
  SEED_ADMIN_EMAIL:    z.string().email().optional(),
  SEED_ADMIN_PASSWORD: z.string().min(12).optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('\n❌  Variables de entorno inválidas o faltantes:\n');
  const errors = parsed.error.flatten().fieldErrors;
  for (const [field, messages] of Object.entries(errors)) {
    console.error(`   ${field}: ${(messages as string[]).join(', ')}`);
  }
  console.error('\n   Revisa tu archivo .env y vuelve a intentarlo.\n');
  process.exit(1);
}

export const env = parsed.data;

// ── JWT decodificado desde base64 ─────────────────────────────────────────────
// Las llaves se guardan en base64 en el .env para evitar problemas con
// saltos de línea y caracteres especiales en distintos sistemas operativos.
export const JWT_PRIVATE_KEY = Buffer.from(env.JWT_PRIVATE_KEY_B64, 'base64').toString('utf-8');
export const JWT_PUBLIC_KEY  = Buffer.from(env.JWT_PUBLIC_KEY_B64,  'base64').toString('utf-8');