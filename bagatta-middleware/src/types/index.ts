import { UserRole } from '@prisma/client';

// ── JWT ───────────────────────────────────────────────────────────────────────
export interface JwtPayload {
  sub: string;       // user id or 'system'
  role: UserRole;
  exp: number;
  iat: number;
  jti: string;       // unique token id (for future revocation)
}

// ── Express augmentation ──────────────────────────────────────────────────────
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
      requestId?: string;
      idempotencyKey?: string;
    }
  }
}

// ── API responses ─────────────────────────────────────────────────────────────
export interface ApiError {
  code: string;
  message: string;
  detail?: string;
  sku?: string;
  request_id?: string;
  timestamp: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: {
    total: number;
    page: number;
    limit: number;
    pages: number;
  };
}

// ── SSE events ────────────────────────────────────────────────────────────────
export type SseEventType =
    | 'sync_tick'
    | 'alert'
    | 'conflict_resolved'
    | 'catchup_start'
    | 'catchup_end'
    | 'heartbeat';

export interface SseEvent {
  type: SseEventType;
  data: Record<string, unknown>;
}

// ── Orchestrator ──────────────────────────────────────────────────────────────
export interface StockDelta {
  sku: string;
  deltaShopify: number;
  deltaAlegra: number;
  newGlobal: number;
}

export interface SyncCycleResult {
  skusChecked: number;
  deltasApplied: number;
  errors: string[];
  durationMs: number;
}

// ── Shopify API shapes ────────────────────────────────────────────────────────
export interface ShopifyVariant {
  id: number;
  sku: string;
  title: string;
  price: string;
  // cost no viene en el payload de webhook por defecto.
  // Se lee desde GET /variants/:id con campo cost (Admin API).
  // En webhooks products/create y products/update no incluye cost,
  // por eso se maneja como opcional y se sincroniza en el polling.
  cost?: string;
  option1?: string | null;
  option2?: string | null;
  option3?: string | null;
  inventory_item_id: number;
  inventory_quantity: number;
  inventory_management: string | null;
}

export interface ShopifyProduct {
  id: number;
  title: string;
  variants: ShopifyVariant[];
}

export interface ShopifyOrder {
  id: number;
  name?: string;      // opcional — no se pide en queries para evitar 403 de datos protegidos
  created_at?: string;
  line_items: Array<{
    variant_id: number;
    sku: string;
    quantity: number;
  }>;
}

export interface ShopifyInventoryLevel {
  inventory_item_id: number;
  location_id: number;
  available: number;
}

// Respuesta de GET /variants/:id con campos extendidos (incluyendo cost)
export interface ShopifyVariantFull extends ShopifyVariant {
  cost?: string; // disponible en la Admin API con permisos de read_product_listings
}

// ── Alegra API shapes ─────────────────────────────────────────────────────────
export interface AlegraItem {
  id: number;
  name: string;
  reference: string; // = SKU de Shopify
  status?: string;
  category?: { id: number | string; name: string };
  price: Array<{ idPriceList: number; name: string; price: number }>;
  inventory: {
    unit: string;
    unitCost?: number;
    availableQuantity: number;
    warehouses: Array<{ id: number; name: string; availableQuantity: number }>;
  };
}

export interface AlegraItemCreatePayload {
  name: string;
  reference: string;
  category: { id: number | string };
  inventory: {
    unit: string;
    initialQuantity: number;
    unitCost?: number;
    minQuantity: number;
    warehouses: Array<{ id: number | string; initialQuantity: number }>;
  };
  price: Array<{ idPriceList: number; price: number }>;
  itemType: 'product';
}

export interface AlegraMovement {
  id: number;
  date: string;
  type: string;
  inventoryItems: Array<{
    item: { id: number; reference: string };
    quantity: number;
  }>;
}