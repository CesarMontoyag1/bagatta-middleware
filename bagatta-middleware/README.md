# Bagatta Middleware

Middleware de sincronización de inventario bidireccional entre **Shopify** (e-commerce) y **Alegra** (ERP/POS/Contabilidad) para Bagatta, tienda de moda retail colombiana.

---

## ¿Qué hace?

Bagatta opera con un único inventario físico compartido entre dos canales de venta simultáneos:

- **Shopify** → tienda virtual (canal online)
- **Alegra** → punto de venta físico (POS + contabilidad)

Este middleware actúa como orquestador central: detecta cambios de stock, precio y costo en cualquiera de los dos canales y los propaga al otro automáticamente cada 10 segundos, garantizando consistencia contable en todo momento.

---

## Principios de diseño

| Principio | Detalle |
|---|---|
| **Shopify como origen de productos** | Los productos se crean en Shopify y se replican a Alegra. Nunca al revés. |
| **Middleware como fuente de verdad de stock** | `master_inventory` es el estado canónico. Ni Shopify ni Alegra mandan individualmente. |
| **Shopify como master de precio/costo** | Los precios y costos se propagan desde Shopify hacia Alegra. Si Alegra modifica un precio, el sistema lo revierte y genera una alerta. |
| **Nunca borrar en Alegra** | Los ítems eliminados en Shopify se archivan en Alegra con sufijo `[INACTIVO]`. El historial contable se preserva siempre. |
| **Autoreparación automática** | Si `master_inventory` o un ítem de Alegra se elimina accidentalmente, el sistema lo detecta y recrea en el siguiente ciclo de polling. |

---

## Stack tecnológico

| Componente | Tecnología |
|---|---|
| Runtime | Node.js 20 + TypeScript |
| Base de datos | PostgreSQL vía **Supabase** (free tier) |
| ORM | Prisma |
| API Framework | Express |
| Autenticación | JWT RS256 + 2FA TOTP |
| Contraseñas | bcrypt (12 rounds) |
| Validación | Zod |
| Scheduler | node-cron |
| Deploy middleware | Render.com (free tier) |
| Deploy dashboard | Vercel (free tier) |

---

## Arquitectura

```
┌─────────────────────────────────────────────────────────────┐
│                      Bagatta Middleware                       │
│                                                               │
│  ┌─────────────┐    ┌──────────────────┐    ┌─────────────┐ │
│  │   Webhook   │    │  Orchestrator    │    │    Cron     │ │
│  │  Receiver   │───▶│     Core         │◀───│  Scheduler  │ │
│  │ (HMAC val.) │    │                  │    │   (10s)     │ │
│  └─────────────┘    └────────┬─────────┘    └─────────────┘ │
│                              │                               │
│                    ┌─────────┴─────────┐                     │
│                    │                   │                     │
│             ┌──────▼──────┐    ┌───────▼──────┐             │
│             │  Shopify    │    │    Alegra    │             │
│             │  Connector  │    │  Connector   │             │
│             └─────────────┘    └──────────────┘             │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                   PostgreSQL (Supabase)                │   │
│  │  product_catalog · master_inventory · audit_log       │   │
│  │  sync_state · purge_history · users · alerts          │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
         ▲                                        ▲
         │ webhooks + polling                     │ polling
         ▼                                        ▼
    ┌─────────┐                            ┌──────────┐
    │ Shopify │                            │  Alegra  │
    └─────────┘                            └──────────┘
```

### Dirección de cada tipo de sincronización

| Tipo | Dirección | Fuente de verdad |
|---|---|---|
| Creación de productos | Shopify → Alegra | Shopify (unidireccional) |
| Stock | Shopify ↔ Master ↔ Alegra | Middleware (`master_inventory`) |
| Precio de venta | Shopify → Alegra | Shopify (con alerta si Alegra modifica) |
| Costo | Shopify → Alegra | Shopify (con alerta si Alegra modifica) |

---

## Estructura del proyecto

```
bagatta-middleware/
├── prisma/
│   └── schema.prisma          # Modelos de BD
├── src/
│   ├── api/
│   │   ├── middlewares/       # auth, errorHandler, rateLimit, requestId
│   │   ├── routes/            # auth, inventory, products, sync, audit, alerts, webhooks, shopifySetup
│   │   └── schemas/           # Validación Zod de inputs
│   ├── config/
│   │   └── env.ts             # Validación de variables de entorno al arranque
│   ├── cron/
│   │   └── scheduler.ts       # Polling cada 10s + purge diario + self-ping
│   ├── db/
│   │   ├── prisma.ts          # Cliente Prisma singleton
│   │   └── seed.ts            # Datos iniciales (sync_state + usuario admin)
│   ├── orchestrator/
│   │   ├── connectors/
│   │   │   ├── alegra.ts      # Adapter API Alegra
│   │   │   ├── shopify.ts     # Adapter API Shopify
│   │   │   └── shopify-auth.ts # Gestión del token OAuth de Shopify
│   │   └── core.ts            # Lógica central de sincronización
│   ├── services/
│   │   ├── alegraBootstrap.ts # Auto-descubrimiento de IDs de Alegra al arrancar
│   │   ├── shopifyBootstrap.ts # Auto-descubrimiento de location_id de Shopify
│   │   ├── audit.ts           # Servicio de audit log
│   │   └── sse.ts             # Server-Sent Events para el dashboard
│   ├── types/
│   │   └── index.ts           # Tipos compartidos
│   ├── utils/
│   │   ├── errors.ts          # Clases de error tipadas
│   │   ├── idempotency.ts     # Generación de idempotency keys
│   │   └── logger.ts          # Logger Winston con manejo de objetos circulares
│   └── index.ts               # Entry point y secuencia de bootstrap
├── .env.example               # Plantilla de variables de entorno
├── docker-compose.yml         # Entorno de desarrollo local
└── package.json
```

---

## Variables de entorno

Copia `.env.example` a `.env` y completa cada valor.

```env
# ── Servidor ─────────────────────────────────────────────
NODE_ENV=development
PORT=3000

# ── Base de datos (Supabase) ──────────────────────────────
DATABASE_URL="postgresql://..."     # Transaction pooler (puerto 6543)
DIRECT_URL="postgresql://..."       # Session pooler (puerto 5432) — para migraciones

# ── JWT RS256 ─────────────────────────────────────────────
# Generar con:
#   openssl genrsa -out private.pem 2048
#   openssl rsa -in private.pem -pubout -out public.pem
# Codificar a base64 (PowerShell):
#   [Convert]::ToBase64String([IO.File]::ReadAllBytes("private.pem"))
JWT_PRIVATE_KEY_B64="..."
JWT_PUBLIC_KEY_B64="..."
JWT_ACCESS_EXPIRES_IN="8h"
JWT_REFRESH_EXPIRES_IN="30d"

# Generar con: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
SYSTEM_INTERNAL_SECRET="..."

# ── Shopify ───────────────────────────────────────────────
# Obtener en: dev.shopify.com → tu app → Configuración
SHOPIFY_SHOP_DOMAIN="tu-tienda.myshopify.com"
SHOPIFY_CLIENT_ID="..."             # ID de cliente de la app
SHOPIFY_CLIENT_SECRET="..."         # Secreto de la app (shpss_...)
SHOPIFY_WEBHOOK_SECRET="..."        # Mismo secreto, para validar HMAC de webhooks
SHOPIFY_API_VERSION="2024-04"
SHOPIFY_ACCESS_TOKEN=""             # Se obtiene automáticamente vía /setup/shopify/install

# Fallback si el scope read_locations no está habilitado en la app:
SHOPIFY_LOCATION_ID="115702923627"  # Opcional — se auto-resuelve si hay permisos
SHOPIFY_LOCATION_NAME=""            # Opcional — para forzar una location por nombre

# ── Alegra ────────────────────────────────────────────────
# Obtener en: Alegra → Configuración → API
ALEGRA_USER_EMAIL="tu@email.com"
ALEGRA_API_TOKEN="..."
# Los IDs se resuelven automáticamente al arrancar por nombre:
ALEGRA_SYNC_CATEGORY_NAME="Tienda Virtual y Física"
ALEGRA_WAREHOUSE_NAME="Principal"
ALEGRA_UNIT_OF_MEASURE="Unidad"

# ── Sincronización ────────────────────────────────────────
POLLING_INTERVAL_SECONDS=10
CATCHUP_THRESHOLD_MINUTES=2
DOWNTIME_ALERT_THRESHOLD_MINUTES=5
SELF_PING_INTERVAL_MINUTES=10

# ── Rate limiting ─────────────────────────────────────────
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=100
AUTH_RATE_LIMIT_MAX=10

# ── CORS y URL propia ─────────────────────────────────────
CORS_ALLOWED_ORIGIN="http://localhost:5173"
SELF_URL="http://localhost:3000"

# ── Seed ──────────────────────────────────────────────────
SEED_ADMIN_EMAIL="admin@bagatta.co"
SEED_ADMIN_PASSWORD="MinimoDoceCaracteres123!"
```

---

## Instalación y primer arranque

### 1. Instalar dependencias

```bash
npm install
```

### 2. Configurar la base de datos

```bash
# Aplicar migraciones a Supabase
npm run db:deploy

# Agregar el constraint singleton (ejecutar en Supabase SQL Editor):
# ALTER TABLE sync_state ADD CONSTRAINT sync_state_singleton CHECK (id = 1);

# Crear usuario admin y fila singleton de sync_state
npm run db:seed
```

### 3. Generar llaves JWT

```powershell
# Windows (PowerShell — requiere Git for Windows o WSL para openssl):
openssl genrsa -out private.pem 2048
openssl rsa -in private.pem -pubout -out public.pem

# Copiar llave privada al portapapeles:
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$PWD\private.pem")) | Set-Clipboard
# → pegar en JWT_PRIVATE_KEY_B64 en el .env

# Copiar llave pública al portapapeles:
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$PWD\public.pem")) | Set-Clipboard
# → pegar en JWT_PUBLIC_KEY_B64 en el .env

# Borrar los .pem del disco:
Remove-Item private.pem, public.pem
```

### 4. Conectar Shopify (OAuth — una sola vez)

En el [Partners Dashboard de Shopify](https://dev.shopify.com) → tu app → **Configuración** → **Allowed redirection URLs**, agrega:

```
http://localhost:3000/setup/shopify/callback
```

Scopes requeridos en la app:
```
read_products, write_products, read_inventory, write_inventory,
read_orders, read_product_listings, read_locations
```

Luego abre en el navegador con el servidor corriendo:

```
http://localhost:3000/setup/shopify/install
```

El middleware completa el OAuth, guarda el token en `.env` y resuelve el `location_id` automáticamente.

### 5. Levantar el servidor

```bash
npm run dev
```

Arranque exitoso:

```
✅  Base de datos conectada (Supabase)
✅  Alegra IDs resueltos — categoría: "Tienda Virtual y Física" → 1 | bodega: "Principal" → ...
✅  Shopify location cargada desde .env: 115702923627   ← si read_locations no está habilitado
   (o)
✅  Shopify location resuelta: "Shop location" → 115702923627   ← si read_locations está activo
⏱  Polling iniciado: cada 10s
✅  Scheduler iniciado
✅  Servidor escuchando en http://localhost:3000
```

---

## Secuencia de bootstrap al arrancar

El servidor ejecuta estos pasos en orden antes de aceptar tráfico:

1. **Validar variables de entorno** — falla rápido con mensaje claro si falta algo crítico
2. **Conectar base de datos** — Supabase/PostgreSQL vía Prisma
3. **Resolver IDs de Alegra** — consulta la API para obtener ID de categoría, bodega y plantilla contable por nombre
4. **Resolver location_id de Shopify** — consulta `/locations.json`; si falla por permisos (403) y hay `SHOPIFY_LOCATION_ID` en `.env`, lo usa silenciosamente sin mostrar errores
5. **Levantar servidor HTTP**
6. **Iniciar scheduler** — polling cada 10s, purge diario a las 3am, self-ping cada 10min (evita sleep de Render)

---

## Flujos principales

### Creación de producto (Shopify → Alegra)

```
1. Operador crea producto con variantes en Shopify (SKU obligatorio en cada variante)
2. Shopify dispara webhook products/create
3. Middleware valida HMAC → responde 200 OK inmediato
4. Por cada variante:
   a. Verificar idempotencia (¿ya existe en product_catalog?)
   b. Obtener costo real desde Shopify /inventory_items/:id
   c. Crear ítem en Alegra: nombre, referencia=SKU, precio, costo,
      stock inicial, bodega, categoría y cuentas contables heredadas
   d. Si Alegra rechaza con error 1009 (referencia duplicada) →
      buscar el ítem existente por reference y vincular en lugar de duplicar
   e. INSERT en product_catalog y master_inventory
   f. INSERT en audit_log
```

### Ciclo de polling (cada 10 segundos)

```
1. Detectar productos nuevos en Shopify no capturados por webhook (2 ciclos de confirmación)
2. Detectar y reparar registros huérfanos (master_inventory o ítem Alegra faltante/borrado)
3. Para cada SKU activo:
   a. Leer stock actual en Shopify y Alegra
   b. Calcular: Δshopify = stockShopifyLast - currentShopify
                Δalegra  = stockAlegraLast  - currentAlegra
   c. Si hay delta: newGlobal = stockGlobal - Δshopify - Δalegra
   d. Actualizar master_inventory con newGlobal y los nuevos _last
   e. Propagar a Shopify (setInventoryLevel) y ajustar Alegra (adjustStock con unitCost real)
   f. Reconciliar precio y costo (Shopify master → revertir si Alegra modificó)
   g. Registrar en audit_log
```

### Catchup sync (recuperación tras caída)

Si el middleware estuvo inactivo más de `CATCHUP_THRESHOLD_MINUTES`:

```
1. Detectar gap = now() - last_successful_sync
2. Para cada SKU activo:
   a. Leer stock REAL actual de Shopify y Alegra
   b. Elegir target: currentShopify (si tiene tracking) o currentAlegra (si no)
   c. Actualizar master_inventory con valores reales
   d. Propagar a la plataforma que difiera del target
3. Generar alerta si gap > DOWNTIME_ALERT_THRESHOLD_MINUTES
```

### Resolución de conflictos (ventas simultáneas)

```
Estado inicial: stockGlobal=10, stockShopifyLast=10, stockAlegraLast=10

Shopify vende 1 → reporta 9  → Δshopify = 10 - 9 = 1
Alegra  vende 1 → reporta 9  → Δalegra  = 10 - 9 = 1

newGlobal = 10 - 1 - 1 = 8  ✓ correcto
Propagar 8 a ambas plataformas
```

---

## API REST

### Autenticación

```bash
POST /api/v1/auth/login
Content-Type: application/json

{ "email": "admin@bagatta.co", "password": "..." }
```

Respuesta: `{ "access_token": "eyJ...", "refresh_token": "...", "role": "admin" }`

Usar en requests protegidos:
```
Authorization: Bearer eyJ...
```

### Endpoints principales

| Método | Ruta | Rol mínimo | Descripción |
|---|---|---|---|
| `GET` | `/health` | público | Estado del servidor |
| `GET` | `/api/v1/status` | readonly | Estado del orquestador y sync_state |
| `GET` | `/api/v1/inventory` | readonly | Lista master_inventory completo |
| `GET` | `/api/v1/products` | readonly | Lista product_catalog |
| `GET` | `/api/v1/audit-log` | readonly | Historial de cambios paginado |
| `GET` | `/api/v1/alerts` | readonly | Alertas activas |
| `POST` | `/api/v1/sync/force/:sku` | operator | Forzar reconciliación de un SKU |
| `POST` | `/api/v1/sync/force/global` | operator | Forzar reconciliación de todos los SKUs |
| `POST` | `/api/v1/sync/reset-master` | operator | Resincronizar master con stock real de ambas plataformas |
| `POST` | `/api/v1/auth/totp/setup` | admin | Generar QR para configurar 2FA |
| `POST` | `/api/v1/auth/totp/verify` | admin | Activar 2FA con primer código |
| `GET` | `/setup/shopify/install` | público | Iniciar OAuth de Shopify |
| `GET` | `/setup/shopify/verify` | público | Verificar que el token de Shopify es válido |
| `GET` | `/setup/shopify/status` | público | Ver estado actual de la conexión con Shopify |

### Webhooks de Shopify

Registrar en Shopify Admin → Settings → Notifications → Webhooks:

| URL | Evento |
|---|---|
| `https://tu-dominio.com/api/v1/webhooks/shopify/products/create` | Product creation |
| `https://tu-dominio.com/api/v1/webhooks/shopify/products/update` | Product update |
| `https://tu-dominio.com/api/v1/webhooks/shopify/products/delete` | Product deletion |

---

## Modelo de datos

### `product_catalog`
Mapa entre variantes de Shopify e ítems de Alegra. Contiene el snapshot `last_known_*` (precio, costo, nombre, opciones) para detectar cambios sin consultar las APIs externas en cada ciclo. Una fila por variante/SKU.

### `master_inventory`
Fuente de verdad del stock global. Una fila por SKU activo. Campos clave: `stock_global`, `stock_shopify_last`, `stock_alegra_last`. Los `_last` permiten calcular deltas independientes por plataforma.

### `audit_log`
Log append-only de operaciones del orquestador. Delta logging: una fila por campo cambiado (nunca el objeto completo). Garantizado único por `idempotency_key`. Retención: 30 días.

### `sync_state`
Tabla singleton (exactamente 1 fila por constraint). Almacena `last_successful_sync`, `status` y `consecutive_failures`.

### `alerts`
Alertas generadas por el sistema (precio modificado en Alegra, SKU migration, downtime, ítems huérfanos). Visibles en el dashboard vía SSE.

---

## Políticas de retención

| Tabla | Retención | Acción |
|---|---|---|
| `audit_log` | 30 días | DELETE automático (PurgeJob 3am) |
| `purge_history` | 90 días | DELETE automático |
| `product_catalog` | Permanente | Marcar `status='archived'` |
| `master_inventory` | Permanente | Vinculado a catalog (CASCADE) |
| `sync_state` | Permanente | Solo UPDATE |
| Historial >30 días | No almacenado | Consultar APIs de Alegra/Shopify |

---

## Robustez y autoreparación

| Escenario | Comportamiento |
|---|---|
| `master_inventory` borrado accidentalmente | Se recrea en el siguiente ciclo con stock real leído de Shopify/Alegra |
| Ítem borrado en Alegra | Se recrea con datos de `product_catalog` y genera alerta |
| `product_catalog` vaciado pero ítem existe en Alegra | Detecta error 1009, vincula al ítem existente, no crea duplicado |
| `location_id` incorrecto en Shopify | `getInventoryLevel` busca en todas las locations y se autocorrige en memoria |
| Downtime del middleware | Al reiniciar, catchup sync reconstruye el estado desde stock real actual |
| Ventas simultáneas en ambos canales | Cálculo de deltas independientes por plataforma, resultado correcto garantizado |
| Webhook perdido | El polling cada 10s actúa como red de seguridad |

---

## Comandos útiles

```bash
npm run dev          # Desarrollo con hot-reload (tsx watch)
npm run build        # Compilar TypeScript a dist/
npm run start        # Producción (requiere build previo)
npm run db:migrate   # Crear nueva migración Prisma
npm run db:deploy    # Aplicar migraciones en producción
npm run db:generate  # Regenerar cliente Prisma tras cambios en schema
npm run db:seed      # Crear usuario admin y fila de sync_state
npm run db:studio    # Abrir Prisma Studio (GUI visual de la BD)
npm run typecheck    # Verificar tipos TypeScript sin compilar
```

---

## Seguridad

- **JWT RS256** — firma asimétrica; la clave privada solo vive en el servidor
- **2FA TOTP** — opcional para admins, compatible con Google Authenticator y Authy
- **bcrypt 12 rounds** — almacenamiento de contraseñas resistente a fuerza bruta
- **HMAC SHA-256** — validación de webhooks de Shopify con `timingSafeEqual`
- **Rate limiting** — por IP, configurable en `.env`
- **Brute force protection** — bloqueo de 15 min tras 5 intentos fallidos de login
- **Input validation** — Zod en todos los endpoints de entrada
- **SQL injection** — Prisma con queries 100% parametrizadas
- **Secrets** — solo en variables de entorno, nunca en código ni en BD sin cifrar
- **CORS restrictivo** — solo orígenes autorizados en `CORS_ALLOWED_ORIGIN`

---

## Despliegue en producción

### Render.com (middleware)

1. Crear **Web Service** conectado al repositorio
2. Build command: `npm run build`
3. Start command: `npm run db:deploy && npm run start`
4. Agregar todas las variables del `.env` en el panel de Environment
5. `NODE_ENV=production`, `SELF_URL=https://tu-app.onrender.com`

> El `SELF_PING_INTERVAL_MINUTES=10` evita que Render duerma el servicio en el free tier.

### Vercel (dashboard UI)

Deployar el frontend React independientemente. Actualizar `CORS_ALLOWED_ORIGIN` con la URL de Vercel.

### Supabase (base de datos)

```bash
# En el servidor de producción, tras el primer deploy:
npm run db:deploy   # Aplica todas las migraciones
npm run db:seed     # Crea el usuario admin
```

---

## Licencia

Proyecto privado — Bagatta. Todos los derechos reservados.