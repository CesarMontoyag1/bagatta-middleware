import axios, { AxiosInstance, AxiosError } from 'axios';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { ShopifyProduct, ShopifyInventoryLevel } from '../../types';
import { shopifyTokenManager } from './shopify-auth';
import { getShopifyLocationId } from '../../services/shopifyBootstrap';
import { TokenBucketLimiter } from '../../utils/rateLimiter';

// Límite real de la API REST Admin de Shopify: 2 requests/segundo sostenido
// por app+tienda. Es una sola instancia compartida por TODO el conector —
// no por request individual — para que la concurrencia de reconcileSku,
// detectNewShopifyProducts, webhooks, etc. respeten juntos el mismo límite
// global, en vez de cada uno pensar que tiene 2 req/s para sí solo.
// Burst conservador (no asumimos que tenemos el balde completo de Shopify
// disponible, ya que otras llamadas del mismo token también lo consumen).
const shopifyRateLimiter = new TokenBucketLimiter(2, 2);

const MAX_429_RETRIES = 3;
const MAX_NETWORK_RETRIES = 3; // timeouts, ECONNRESET, DNS, etc. — antes nunca se reintentaban

class ShopifyConnector {
  private baseURL: string;

  constructor() {
    this.baseURL = `https://${env.SHOPIFY_SHOP_DOMAIN}/admin/api/${env.SHOPIFY_API_VERSION}`;
    logger.info(`Shopify connector: ${this.baseURL}`);
  }

  /**
   * Lista todas las locations de la tienda.
   * Usado por shopifyBootstrap para resolver el location_id automáticamente.
   * No depende de getShopifyLocationId() — rompe el ciclo de inicialización.
   */
  async listLocations(): Promise<Array<{ id: number; name: string; active: boolean }>> {
    this.assertTokenValid();
    const { data } = await this.getClient().get('/locations.json');
    return (data.locations ?? []) as Array<{ id: number; name: string; active: boolean }>;
  }

  private getClient(): AxiosInstance {
    const token = shopifyTokenManager.getToken();
    const client = axios.create({
      baseURL: this.baseURL,
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });

    // ── Antes de cada request: esperar turno según el rate limiter ─────────
    client.interceptors.request.use(async (config) => {
      await shopifyRateLimiter.acquire();
      return config;
    });

    client.interceptors.response.use(
        (r) => r,
        async (err: AxiosError) => {
          const status = err.response?.status;
          const url    = err.config?.url;
          const data   = err.response?.data;

          // ── Error de RED (sin respuesta HTTP) — timeout, conexión reseteada,
          // DNS, etc. Antes esto se logueaba como "status undefined, data {}"
          // sin información útil, y nunca se reintentaba (el retry solo
          // cubría 429). Ahora: reintenta con backoff igual que un 429, y
          // loguea el código real del error de red (ECONNRESET, ETIMEDOUT...).
          if (!err.response) {
            const cfg = err.config as (typeof err.config & { __netRetryCount?: number });
            const retryCount = cfg?.__netRetryCount ?? 0;

            logger.warn(
                `Shopify: error de red en ${url} — código=${err.code ?? 'desconocido'} ` +
                `mensaje="${err.message || '(sin mensaje)'}"`,
            );

            if (cfg && retryCount < MAX_NETWORK_RETRIES) {
              const waitMs = 1000 * Math.pow(2, retryCount); // 1s, 2s, 4s...
              logger.warn(`Shopify: reintentando ${url} en ${waitMs}ms (${retryCount + 1}/${MAX_NETWORK_RETRIES})`);
              cfg.__netRetryCount = retryCount + 1;
              await new Promise((resolve) => setTimeout(resolve, waitMs));
              return client.request(cfg);
            }

            logger.error(
                `Shopify: error de red persistente en ${url} tras ${MAX_NETWORK_RETRIES} reintentos ` +
                `— código=${err.code ?? 'desconocido'}`,
            );
            throw err;
          }

          // ── 429: reintentar con backoff, respetando Retry-After si viene ──
          if (status === 429) {
            const cfg = err.config as (typeof err.config & { __retryCount?: number });
            const retryCount = cfg?.__retryCount ?? 0;

            if (cfg && retryCount < MAX_429_RETRIES) {
              const retryAfterHeader = err.response?.headers?.['retry-after'];
              const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : 1;
              const waitMs = (Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : 1) * 1000;

              logger.warn(
                  `Shopify 429 en ${url} — reintento ${retryCount + 1}/${MAX_429_RETRIES} ` +
                  `en ${waitMs}ms (Retry-After respetado)`,
              );

              cfg.__retryCount = retryCount + 1;
              await new Promise((resolve) => setTimeout(resolve, waitMs));
              return client.request(cfg);
            }

            logger.error(
                `Shopify 429 en ${url} — agotados los ${MAX_429_RETRIES} reintentos`, { data },
            );
            throw err;
          }

          if (status === 401) {
            shopifyTokenManager.markInvalid();
            logger.error(`Shopify 401 en ${url} — token inválido`, { data });
          } else {
            logger.error(`Shopify API error ${status} en ${url} — mensaje="${err.message}"`, { data });
          }
          throw err;
        },
    );
    return client;
  }

  private assertTokenValid(): void {
    if (!shopifyTokenManager.isValid()) {
      throw new Error('Shopify no autenticado. Visita http://localhost:3000/setup/shopify/install');
    }
  }

  async verifyConnection(): Promise<{ name: string; domain: string }> {
    const { data } = await this.getClient().get('/shop.json');
    return { name: data.shop?.name, domain: data.shop?.myshopify_domain };
  }

  async getProduct(productId: string): Promise<ShopifyProduct> {
    this.assertTokenValid();
    const { data } = await this.getClient().get(`/products/${productId}.json`);
    return data.product as ShopifyProduct;
  }

  async listProducts(sinceId?: string): Promise<ShopifyProduct[]> {
    this.assertTokenValid();
    const params: Record<string, string> = { limit: '250' };
    if (sinceId) params.since_id = sinceId;
    const { data } = await this.getClient().get('/products.json', { params });
    return data.products as ShopifyProduct[];
  }

  /**
   * Obtiene el stock disponible de un inventory_item en la location configurada.
   * Si no encuentra nivel en esa location, busca en TODAS las locations y
   * actualiza el bootstrap con el location_id correcto automáticamente.
   */
  // Trae niveles de inventario de MUCHOS inventory_item_ids en pocas llamadas
  // (hasta 250 por request, límite de Shopify) — usado por FastShopifySync
  // para no tener que preguntar SKU por SKU.
  async getInventoryLevelsBulk(inventoryItemIds: number[]): Promise<Map<number, number>> {
    this.assertTokenValid();
    const locationId = getShopifyLocationId();
    const result = new Map<number, number>();

    const CHUNK_SIZE = 250;
    for (let i = 0; i < inventoryItemIds.length; i += CHUNK_SIZE) {
      const chunk = inventoryItemIds.slice(i, i + CHUNK_SIZE);

      // Cada página se aísla: si una falla (incluso tras los reintentos del
      // interceptor), NO debe tumbar la corrida completa — las demás páginas
      // (y por tanto los demás SKUs) siguen procesándose. La página fallida
      // simplemente queda para el siguiente tick (30s después) o el ciclo
      // lento de seguridad.
      try {
        const { data } = await this.getClient().get('/inventory_levels.json', {
          params: {
            inventory_item_ids: chunk.join(','),
            location_ids:       locationId,
            limit:              250,
          },
        });
        const levels = (data.inventory_levels ?? []) as ShopifyInventoryLevel[];
        for (const level of levels) {
          result.set(level.inventory_item_id, level.available);
        }
      } catch (err) {
        logger.error(
            `getInventoryLevelsBulk: página ${i / CHUNK_SIZE + 1} falló ` +
            `(${chunk.length} SKUs omitidos en este tick) — ${(err as Error).message}`,
        );
        // No relanzar — seguir con la siguiente página
      }
    }

    return result;
  }

  async getInventoryLevel(inventoryItemId: number): Promise<number> {
    this.assertTokenValid();
    const locationId = getShopifyLocationId();
    const { data } = await this.getClient().get('/inventory_levels.json', {
      params: { inventory_item_ids: inventoryItemId, location_ids: locationId },
    });
    const levels = data.inventory_levels as ShopifyInventoryLevel[];

    if (levels.length > 0) {
      return levels[0].available;
    }

    // No hay nivel en la location configurada — buscar en todas las locations
    const { data: allData } = await this.getClient().get('/inventory_levels.json', {
      params: { inventory_item_ids: inventoryItemId },
    });
    const allLevels = allData.inventory_levels as ShopifyInventoryLevel[];

    if (allLevels.length === 0) {
      logger.warn(`Shopify: inventory_item ${inventoryItemId} sin niveles en ninguna location`);
      return 0;
    }

    // Tomar el nivel con mayor stock disponible (más probable que sea el correcto)
    const best = allLevels.reduce((a, b) => a.available >= b.available ? a : b);

    logger.warn(
        `Shopify: inventory_item ${inventoryItemId} no encontrado en location ${locationId}. ` +
        `Usando location ${best.location_id} con available=${best.available}. ` +
        `Actualiza SHOPIFY_LOCATION_ID="${best.location_id}" en el .env.`,
    );

    // Auto-corregir el location_id en memoria para este ciclo y los siguientes
    if (best.available > 0) {
      const { overrideShopifyLocationId } = await import('../../services/shopifyBootstrap');
      overrideShopifyLocationId(String(best.location_id));
    }

    return best.available;
  }

  /**
   * Conecta un inventory_item a la location configurada.
   * Requerido antes de poder hacer set/adjust cuando el tracking acaba de activarse
   * o cuando el item nunca estuvo asociado a esa location.
   * Es idempotente — si ya está conectado, Shopify devuelve el nivel existente.
   */
  async connectInventoryLevel(inventoryItemId: number): Promise<void> {
    this.assertTokenValid();
    try {
      await this.getClient().post('/inventory_levels/connect.json', {
        location_id:       parseInt(getShopifyLocationId(), 10),
        inventory_item_id: inventoryItemId,
        relocate_if_necessary: false,
      });
      logger.info(`Shopify: inventory_item ${inventoryItemId} conectado a location ${getShopifyLocationId()}`);
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      // 422 = ya estaba conectado — no es un error real
      if (status === 422) {
        logger.debug(`Shopify: inventory_item ${inventoryItemId} ya estaba conectado a location ${getShopifyLocationId()}`);
        return;
      }
      // 404 = el inventory_item_id no existe en absoluto (variante eliminada,
      // o el ID que se tenía cacheado ya no es válido). No es recuperable aquí
      // — quien llama debe manejar el caso de "sin stock disponible".
      if (status === 404) {
        logger.warn(
            `Shopify: inventory_item ${inventoryItemId} no existe (404) al intentar conectar a location ${getShopifyLocationId()}.`,
        );
        return;
      }
      throw err;
    }
  }

  async setInventoryLevel(inventoryItemId: number, quantity: number): Promise<void> {
    this.assertTokenValid();
    try {
      await this.getClient().post('/inventory_levels/set.json', {
        location_id:       parseInt(getShopifyLocationId(), 10),
        inventory_item_id: inventoryItemId,
        available:         quantity,
      });
      logger.debug(`Shopify: inventory_item ${inventoryItemId} → ${quantity}`);
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      // 404 = el item no está conectado a esta location todavía
      // Conectar y reintentar automáticamente
      if (status === 404) {
        logger.warn(
            `Shopify: inventory_item ${inventoryItemId} no conectado a location ${getShopifyLocationId()}. ` +
            `Conectando y reintentando...`,
        );
        await this.connectInventoryLevel(inventoryItemId);
        // Reintentar el set tras conectar
        await this.getClient().post('/inventory_levels/set.json', {
          location_id:       parseInt(getShopifyLocationId(), 10),
          inventory_item_id: inventoryItemId,
          available:         quantity,
        });
        logger.info(`Shopify: inventory_item ${inventoryItemId} → ${quantity} (tras reconexión)`);
        return;
      }
      throw err;
    }
  }

  async updateVariantPrice(variantId: string, price: string): Promise<void> {
    this.assertTokenValid();
    await this.getClient().put(`/variants/${variantId}.json`, {
      variant: { id: variantId, price },
    });
    logger.debug(`Shopify: variant ${variantId} precio → ${price}`);
  }

  async getVariantCost(inventoryItemId: number): Promise<number> {
    this.assertTokenValid();
    try {
      const { data } = await this.getClient().get(`/inventory_items/${inventoryItemId}.json`);
      const cost = data.inventory_item?.cost;
      return cost ? parseFloat(cost) : 0;
    } catch {
      logger.warn(`Shopify: no se pudo obtener costo de inventory_item ${inventoryItemId}`);
      return 0;
    }
  }

  async getOrdersSince(createdAtMin: Date): Promise<Array<{
    id: number; name: string; created_at: string;
    line_items: Array<{ variant_id: number; sku: string; quantity: number }>;
  }>> {
    this.assertTokenValid();
    const allOrders: Array<{
      id: number; name: string; created_at: string;
      line_items: Array<{ variant_id: number; sku: string; quantity: number }>;
    }> = [];

    let pageInfo: string | undefined;
    let isFirstPage = true;

    while (true) {
      const params: Record<string, string> = {
        status: 'any',
        limit:  '250',
        // Solo campos no protegidos — evita el 403 de "protected customer data".
        // El middleware solo necesita SKU y cantidad para calcular deltas de stock.
        fields: 'id,created_at,line_items',
      };

      if (isFirstPage) {
        params.created_at_min = createdAtMin.toISOString();
        isFirstPage = false;
      } else if (pageInfo) {
        params.page_info = pageInfo;
      } else {
        break;
      }

      const { data, headers } = await this.getClient().get('/orders.json', { params });
      const orders = data.orders ?? [];
      allOrders.push(...orders);

      const linkHeader = headers['link'] as string | undefined;
      pageInfo = this.extractNextPageInfo(linkHeader);
      if (!pageInfo || orders.length < 250) break;
    }

    return allOrders;
  }

  async getVariantInventoryItemId(variantId: string): Promise<number> {
    this.assertTokenValid();
    const { data } = await this.getClient().get(`/variants/${variantId}.json`);
    return data.variant.inventory_item_id as number;
  }

  async getVariant(variantId: string): Promise<{ inventory_item_id: number; inventory_management: string | null }> {
    this.assertTokenValid();
    const { data } = await this.getClient().get(`/variants/${variantId}.json`);
    return {
      inventory_item_id:    data.variant.inventory_item_id as number,
      inventory_management: (data.variant.inventory_management as string | null) ?? null,
    };
  }

  private extractNextPageInfo(linkHeader?: string): string | undefined {
    if (!linkHeader) return undefined;
    const match = linkHeader.match(/<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/);
    return match ? match[1] : undefined;
  }
}

export const shopifyConnector = new ShopifyConnector();