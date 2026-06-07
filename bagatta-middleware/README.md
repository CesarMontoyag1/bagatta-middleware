# Bagatta Middleware

Middleware de sincronización de inventario bidireccional **Shopify ↔ Alegra**.

---

## Stack

- **Runtime**: Node.js 20 + TypeScript
- **Framework**: Express 4
- **ORM**: Prisma 5
- **BD**: PostgreSQL via Supabase (producción) / local Docker (desarrollo)
- **Auth**: JWT RS256 + RBAC
- **Real-time**: Server-Sent Events (SSE)
- **Cron**: node-cron + setInterval (polling cada 10s)

---

## Setup inicial (WSL2)

### 1. Clonar y entrar al proyecto
```bash
cd ~/projects   # o la carpeta que uses
git clone <repo>
cd bagatta-middleware
```

### 2. Instalar dependencias
```bash
npm install
```

### 3. Generar par de claves RS256 para JWT
```bash
# Instalar openssl si no lo tienes
sudo apt-get install -y openssl

# Generar par de claves
openssl genrsa -out private.pem 2048
openssl rsa -in private.pem -pubout -out public.pem

# Convertir a base64 de una línea (para pegar en .env)
cat private.pem | base64 -w 0
cat public.pem  | base64 -w 0
```

### 4. Configurar variables de entorno
```bash
cp .env.example .env
# Editar .env con tus credenciales reales
nano .env   # o code .env
```

Variables mínimas para arrancar en desarrollo:
- `DATABASE_URL` y `DIRECT_URL` → URLs de Supabase
- `JWT_PRIVATE_KEY_B64` y `JWT_PUBLIC_KEY_B64` → del paso anterior
- `SYSTEM_INTERNAL_SECRET` → string aleatorio largo
- `SHOPIFY_*` → credenciales de tu app privada en Shopify
- `ALEGRA_*` → credenciales de la API de Alegra

### 5. Configurar Supabase
1. Crea un proyecto en [supabase.com](https://supabase.com)
2. Ve a **Settings > Database > Connection string**
3. Copia la URL de "Transaction" (puerto 6543) → `DATABASE_URL`
4. Copia la URL de "Session" (puerto 5432) → `DIRECT_URL`

### 6. Crear las tablas (migración)
```bash
npm run db:migrate
# Nombre de la migración: init
```

### 7. Seed inicial
```bash
# Agregar al .env:
# SEED_ADMIN_EMAIL=admin@bagatta.co
# SEED_ADMIN_PASSWORD=tu_password_seguro

npm run db:seed
```

### 8. Arrancar en desarrollo
```bash
npm run dev
```

El servidor arranca en `http://localhost:3000`.

---

## Verificación rápida

```bash
# Health check (sin auth)
curl http://localhost:3000/health

# Login
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@bagatta.co","password":"tu_password"}'

# Status (con token)
curl http://localhost:3000/api/v1/status \
  -H "Authorization: Bearer <ACCESS_TOKEN>"
```

---

## Comandos útiles

```bash
npm run dev          # Desarrollo con hot-reload
npm run build        # Compilar TypeScript
npm run typecheck    # Verificar tipos sin compilar
npm run db:migrate   # Nueva migración
npm run db:studio    # Abrir Prisma Studio (UI de BD)
npm run db:seed      # Seed inicial
```

---

## Estructura del proyecto

```
src/
├── api/
│   ├── app.ts              # Express factory
│   ├── middlewares/        # auth, rateLimit, idempotency, errorHandler
│   ├── routes/             # Un archivo por dominio
│   └── schemas/            # Validación Zod por endpoint
├── config/
│   └── env.ts              # Validación de variables de entorno con Zod
├── cron/
│   └── scheduler.ts        # Polling + heartbeat + purge + self-ping
├── db/
│   ├── prisma.ts           # Singleton PrismaClient
│   └── seed.ts             # Seed inicial
├── orchestrator/
│   ├── core.ts             # Lógica de sync, conflictos, catchup
│   └── connectors/
│       ├── shopify.ts      # Wrapper API Shopify
│       └── alegra.ts       # Wrapper API Alegra
├── services/
│   ├── audit.ts            # Audit log append-only
│   └── sse.ts              # Server-Sent Events
├── types/
│   └── index.ts            # Tipos compartidos
├── utils/
│   ├── errors.ts           # Clases de error tipadas
│   ├── idempotency.ts      # Generadores de keys
│   └── logger.ts           # Winston logger
└── index.ts                # Entry point + bootstrap
```

---

## Flujo de webhooks en desarrollo local

Para recibir webhooks de Shopify en local, necesitas exponer tu puerto con ngrok:

```bash
# Instalar ngrok (WSL2)
curl -s https://ngrok-agent.s3.amazonaws.com/ngrok.asc | sudo gpg --dearmor -o /etc/apt/keyrings/ngrok.gpg
echo "deb [signed-by=/etc/apt/keyrings/ngrok.gpg] https://ngrok-agent.s3.amazonaws.com buster main" | sudo tee /etc/apt/sources.list.d/ngrok.list
sudo apt update && sudo apt install ngrok

# Iniciar túnel
ngrok http 3000

# Registrar webhook en Shopify con la URL de ngrok:
# https://xxxx.ngrok.io/api/v1/webhooks/shopify/products/create
```

---

## Producción (Render.com)

1. Conectar el repositorio en Render
2. **Build command**: `npm ci && npm run build && npx prisma generate`
3. **Start command**: `npm run db:deploy && node dist/index.js`
4. Agregar todas las variables de entorno desde `.env.example`
5. El health check de Render apunta a `/health`
