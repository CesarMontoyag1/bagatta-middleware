# Conexiones — Guía de credenciales del `.env`

Este documento explica paso a paso cómo conseguir cada variable de entorno del proyecto **Bagatta Middleware**. Úsalo como referencia cada vez que necesites recrear el `.env` (proyecto nuevo, credencial rotada, entorno nuevo, etc.).

⚠️ **Nunca subas el `.env` real a GitHub.** Debe estar en `.gitignore` siempre.

---

## 1. Base de datos — Supabase

Supabase requiere **dos** variables distintas porque usan conexiones diferentes según el propósito:

| Variable | Uso | Puerto | Compatible con Render/Vercel (IPv4) |
|---|---|---|---|
| `DATABASE_URL` | Runtime — el middleware la usa todo el tiempo | 6543 (pooler, modo *Transaction*) | ✅ Sí |
| `DIRECT_URL` | Solo migraciones (`prisma migrate deploy`) | 5432 (pooler, modo *Session*) | ✅ Sí |

### Pasos para conseguirlas

1. Entra a [supabase.com/dashboard](https://supabase.com/dashboard) → selecciona tu proyecto.
2. En la barra superior, haz clic en el botón **"Connect"**.
3. En el panel que se abre, busca la sección **"Connection string"** — vas a ver el host, puerto, usuario y base de datos.
4. Copia el **host del pooler**, algo como:
   ```
   aws-X-us-west-2.pooler.supabase.com
   ```
5. Copia el **usuario**, con este formato (incluye la referencia de tu proyecto):
   ```
   postgres.tu-referencia-de-proyecto
   ```
6. Arma las dos URLs:

   ```env
   DATABASE_URL="postgresql://postgres.tu-referencia:TU_PASSWORD@aws-X-us-west-2.pooler.supabase.com:6543/postgres?pgbouncer=true"
   DIRECT_URL="postgresql://postgres.tu-referencia:TU_PASSWORD@aws-X-us-west-2.pooler.supabase.com:5432/postgres"
   ```

   Diferencias clave entre ambas:
    - `DATABASE_URL` usa el puerto **6543** y termina en `?pgbouncer=true`.
    - `DIRECT_URL` usa el puerto **5432** y **no** lleva `?pgbouncer=true`.
    - Ambas usan el **mismo host del pooler** — no el host de conexión directa (`db.tu-referencia.supabase.co`), porque ese resuelve solo por IPv6 y falla tanto en Render/Vercel como en muchas redes locales.

### Sobre la contraseña

- Si no la recuerdas: **Database → Settings → Reset database password** (genera una nueva; invalida la anterior).
- Si tu contraseña tiene caracteres especiales, debes **codificarlos como percent-encoding** en la URL. Los más comunes:

  | Carácter | Código |
    |---|---|
  | `*` | `%2A` |
  | `@` | `%40` |
  | `#` | `%23` |
  | `/` | `%2F` |
  | `?` | `%3F` |
  | `%` | `%25` |

  Ejemplo: `Marien_062515*` → `Marien_062515%2A`

### Después de armar las URLs — inicializar el esquema

Si es un proyecto de Supabase nuevo (base de datos vacía), corre en orden:

```powershell
npx prisma migrate deploy
npm run db:seed
```

`migrate deploy` crea todas las tablas; `db:seed` crea el usuario admin inicial y el registro `sync_state`.

---

## 2. JWT (autenticación del middleware)

Estas claves **no tienen relación con Supabase, Shopify ni Alegra** — son exclusivas de tu propio servidor, para firmar los tokens de login. No cambian cuando rotas otras credenciales.

### Generarlas desde cero

En PowerShell o Git Bash, con OpenSSL instalado:

```bash
openssl genrsa -out private.pem 2048
openssl rsa -in private.pem -pubout -out public.pem
```

Luego conviértelas a base64 (PowerShell):

```powershell
[Convert]::ToBase64String([System.IO.File]::ReadAllBytes("private.pem"))
[Convert]::ToBase64String([System.IO.File]::ReadAllBytes("public.pem"))
```

Pega cada resultado en:

```env
JWT_PRIVATE_KEY_B64="..."
JWT_PUBLIC_KEY_B64="..."
```

⚠️ Si generas un par nuevo, **todas las sesiones activas quedan invalidadas** — hay que volver a hacer login.

### El secreto interno del sistema

```env
SYSTEM_INTERNAL_SECRET="..."
```

Se genera con:

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

---

## 3. Shopify

### 3.1 Dominio de la tienda

```env
SHOPIFY_SHOP_DOMAIN="tu-tienda.myshopify.com"
```

Es literalmente la URL de tu tienda en el admin.

### 3.2 Access Token (app personalizada / custom app)

1. En el admin de Shopify → **Settings → Apps and sales channels → Develop apps**.
2. Abre tu app (o créala si es nueva: **Create an app**).
3. Ve a **Configuration → Admin API integration** y marca los scopes necesarios (como mínimo: `read_products`, `write_products`, `read_inventory`, `write_inventory`, `read_locations`, `read_orders`).
4. Guarda, luego **Install app** (o **Update permissions** si ya estaba instalada y cambiaste scopes).
5. Ve a **API credentials** → copia el **Admin API access token** (empieza con `shpua_`). Solo se muestra una vez al generarlo — cópialo de inmediato.

```env
SHOPIFY_ACCESS_TOKEN="shpua_..."
```

### 3.3 Client ID y Client Secret (para flujo OAuth, si aplica)

En el **Partners Dashboard** → tu app → **Configuration → Credenciales**:

```env
SHOPIFY_CLIENT_ID="..."
SHOPIFY_CLIENT_SECRET="..."
```

### 3.4 Webhook Secret

⚠️ **No es el mismo valor que `SHOPIFY_CLIENT_SECRET`** — son secretos distintos con propósitos distintos. Encuéntralo en:

- Partners Dashboard → tu app → **Webhooks**, o
- Si registraste los webhooks vía API (`register_webhooks.ps1`), el secret de verificación HMAC es el que Shopify te asigna al crear la suscripción — revísalo en la sección de Notifications/Webhooks del admin.

```env
SHOPIFY_WEBHOOK_SECRET="shpss_..."
```

### 3.5 Location ID (opcional — se resuelve solo)

No es obligatorio definirlo — el middleware lo resuelve automáticamente al arrancar, consultando `/locations.json`. Solo defínelo si tienes varias ubicaciones y quieres forzar una específica por nombre:

```env
SHOPIFY_LOCATION_NAME="Nombre exacto de la ubicación"
```

### 3.6 Registrar los webhooks

Sin esto, Shopify nunca avisa de ventas ni cambios — usa el script ya construido:

```powershell
.\register_webhooks.ps1 -ShopifyToken "shpua_tu_token"
```

(Nota: el proyecto también corre `FastShopifySync` y `FastAlegraSync` de forma independiente a los webhooks, así que aunque no registres los webhooks, el sistema sigue funcionando — solo un poco menos instantáneo.)

---

## 4. Alegra

### 4.1 Email y API Token

1. Entra a tu cuenta de Alegra → **Configuración** (ícono de engranaje) → busca la sección de **Integraciones / API** (o similar, depende de la versión del panel).
2. Genera o copia tu **token de API**.
3. El email es el mismo con el que inicias sesión en Alegra.

```env
ALEGRA_USER_EMAIL="tu_email@dominio.com"
ALEGRA_API_TOKEN="..."
```

### 4.2 Categoría, bodega y unidad de medida

Estos son **nombres exactos** tal como existen en tu cuenta de Alegra — el middleware resuelve automáticamente sus IDs al arrancar, buscándolos por nombre:

```env
ALEGRA_SYNC_CATEGORY_NAME="Tienda Virtual y Física"
ALEGRA_WAREHOUSE_NAME="Principal"
ALEGRA_UNIT_OF_MEASURE="Unidad"
```

Confirma en Alegra → **Inventario → Categorías** / **Bodegas** que estos nombres existan exactamente así (mayúsculas/tildes incluidas).

### 4.3 Cuentas contables (opcionales)

Normalmente **no hace falta definirlas** — el bootstrap automático las resuelve leyendo un ítem existente en Alegra. Solo actívalas si ves el error "no se pudo resolver plantilla contable" al arrancar:

```env
# ALEGRA_INVENTORY_ACCOUNT_ID=""
# ALEGRA_SALE_COST_ACCOUNT_ID=""
# ALEGRA_SALE_INCOME_ACCOUNT_ID=""
```

---

## 5. Seed (usuario admin inicial)

```env
SEED_ADMIN_EMAIL="admin@tudominio.com"
SEED_ADMIN_PASSWORD="ContraseñaSegura123!"
```

Se usan solo al correr `npm run db:seed`. Requisito: mínimo 12 caracteres.

⚠️ Si tu contraseña tiene caracteres especiales (ñ, tildes, `!`), recuerda el problema de encoding que tuvimos con PowerShell — usa los scripts `login.ps1`/`request.ps1` del proyecto, que ya fuerzan UTF-8 explícitamente para evitar que se corrompan.

---

## 6. Variables de configuración general (no requieren credenciales externas)

Estas no se "consiguen" de ningún proveedor — son configuración propia del proyecto, con valores por defecto razonables:

```env
NODE_ENV=production
PORT=3000

POLLING_INTERVAL_SECONDS=1800
ALEGRA_FAST_SYNC_INTERVAL_SECONDS=60
SHOPIFY_FAST_SYNC_INTERVAL_SECONDS=60
CATALOG_CACHE_REFRESH_MINUTES=15
CATCHUP_THRESHOLD_MINUTES=35
DOWNTIME_ALERT_THRESHOLD_MINUTES=50
SELF_PING_INTERVAL_MINUTES=10

RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=100
AUTH_RATE_LIMIT_MAX=10

CORS_ALLOWED_ORIGIN="https://tu-dashboard.vercel.app"
SELF_URL="https://tu-middleware.onrender.com"
```

---

## 7. Checklist rápido para un entorno completamente nuevo

1. [ ] Crear proyecto en Supabase → conseguir `DATABASE_URL` y `DIRECT_URL` (sección 1)
2. [ ] Generar claves JWT nuevas (sección 2)
3. [ ] Generar `SYSTEM_INTERNAL_SECRET` (sección 2)
4. [ ] Conseguir/crear Access Token de Shopify (sección 3.2)
5. [ ] Conseguir Webhook Secret de Shopify (sección 3.4)
6. [ ] Conseguir API Token de Alegra (sección 4.1)
7. [ ] Confirmar nombres de categoría/bodega en Alegra (sección 4.2)
8. [ ] Definir usuario admin del seed (sección 5)
9. [ ] Correr `npx prisma migrate deploy`
10. [ ] Correr `npm run db:seed`
11. [ ] Correr `.\register_webhooks.ps1` (opcional, mejora la reactividad)
12. [ ] `npm run dev` y confirmar que arrancan los 3 ciclos (polling, FastAlegraSync, FastShopifySync) sin errores