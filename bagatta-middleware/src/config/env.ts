import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT:     z.coerce.number().default(3000),

  DATABASE_URL: z.string().min(1),
  DIRECT_URL:   z.string().min(1),

  JWT_PRIVATE_KEY_B64:    z.string().min(1),
  JWT_PUBLIC_KEY_B64:     z.string().min(1),
  JWT_ACCESS_EXPIRES_IN:  z.string().default('8h'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),
  SYSTEM_INTERNAL_SECRET: z.string().min(32),

  // ── Shopify ──────────────────────────────────────────────────────────────
  SHOPIFY_SHOP_DOMAIN:    z.string().min(1),
  SHOPIFY_API_VERSION:    z.string().default('2024-04'),
  SHOPIFY_WEBHOOK_SECRET: z.string().min(1),
  // SHOPIFY_LOCATION_ID ya no es obligatoria — se resuelve automáticamente
  // al arrancar (shopifyBootstrap) consultando /locations.json.
  // SHOPIFY_LOCATION_NAME es opcional: si tienes varias locations y quieres
  // forzar una específica por nombre exacto, defínela aquí.
  SHOPIFY_LOCATION_ID:   z.string().default(''),
  SHOPIFY_LOCATION_NAME: z.string().default(''),

  // El access token se obtiene via OAuth (/setup/shopify/install).
  // Puede estar vacío inicialmente — el setup lo completa automáticamente.
  SHOPIFY_ACCESS_TOKEN: z.string().default(''),

  // Client ID y Secret: solo necesarios para el flujo OAuth de setup.
  // Vienen del Partners Dashboard → tu app → Configuración → Credenciales.
  SHOPIFY_CLIENT_ID:     z.string().default(''),
  SHOPIFY_CLIENT_SECRET: z.string().default(''),

  // ── Alegra ───────────────────────────────────────────────────────────────
  ALEGRA_USER_EMAIL:         z.string().email(),
  ALEGRA_API_TOKEN:          z.string().min(1),
  ALEGRA_SYNC_CATEGORY_NAME: z.string().default('Tienda Virtual y Física'),
  ALEGRA_WAREHOUSE_NAME:     z.string().default('Principal'),
  ALEGRA_UNIT_OF_MEASURE:    z.string().default('Unidad'),

  // ── Sincronización ───────────────────────────────────────────────────────
  POLLING_INTERVAL_SECONDS:         z.coerce.number().default(10),
  CATCHUP_THRESHOLD_MINUTES:        z.coerce.number().default(2),
  DOWNTIME_ALERT_THRESHOLD_MINUTES: z.coerce.number().default(5),
  SELF_PING_INTERVAL_MINUTES:       z.coerce.number().default(10),

  // ── Rate limiting ────────────────────────────────────────────────────────
  RATE_LIMIT_WINDOW_MS:    z.coerce.number().default(60000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().default(100),
  AUTH_RATE_LIMIT_MAX:     z.coerce.number().default(10),

  // ── CORS y URLs ──────────────────────────────────────────────────────────
  CORS_ALLOWED_ORIGIN: z.string().default('http://localhost:5173'),
  SELF_URL:            z.string().default('http://localhost:3000'),

  // ── Seed ─────────────────────────────────────────────────────────────────
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

export const JWT_PRIVATE_KEY = Buffer.from(env.JWT_PRIVATE_KEY_B64, 'base64').toString('utf-8');
export const JWT_PUBLIC_KEY  = Buffer.from(env.JWT_PUBLIC_KEY_B64,  'base64').toString('utf-8');