import axios, { AxiosInstance, AxiosError } from 'axios';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { ShopifyProduct, ShopifyInventoryLevel } from '../../types';
import { shopifyTokenManager } from './shopify-auth';

/**
 * Normaliza el SHOPIFY_LOCATION_ID.
 * Acepta formato GID GraphQL (gid://shopify/Location/118506684576)
 * y formato numérico simple (118506684576).
 * La REST API requiere solo el número.
 */
function normalizeLocationId(raw: string): string {
  if (raw.startsWith('gid://')) {
    const parts = raw.split('/');
    return parts[parts.length - 1];
  }
  return raw;
}

const LOCATION_ID = normalizeLocationId(env.SHOPIFY_LOCATION_ID);

class ShopifyConnector {
  private baseURL: string;

  constructor() {
    this.baseURL = `https://${env.SHOPIFY_SHOP_DOMAIN}/admin/api/${env.SHOPIFY_API_VERSION}`;
    logger.info(`Shopify connector: ${this.baseURL} | Location: ${LOCATION_ID}`);
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

    client.interceptors.response.use(
        (r) => r,
        (err: AxiosError) => {
          const status = err.response?.status;
          const url    = err.config?.url;
          const data   = err.response?.data;
          if (status === 401) {
            shopifyTokenManager.markInvalid();
            logger.error(`Shopify 401 en ${url} — token inválido`, { data });
          } else {
            logger.error(`Shopify API error ${status} en ${url}`, { data });
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

  async getInventoryLevel(inventoryItemId: number): Promise<number> {
    this.assertTokenValid();
    const { data } = await this.getClient().get('/inventory_levels.json', {
      params: { inventory_item_ids: inventoryItemId, location_ids: LOCATION_ID },
    });
    const level = (data.inventory_levels as ShopifyInventoryLevel[])[0];
    return level?.available ?? 0;
  }

  async setInventoryLevel(inventoryItemId: number, quantity: number): Promise<void> {
    this.assertTokenValid();
    await this.getClient().post('/inventory_levels/set.json', {
      location_id: parseInt(LOCATION_ID, 10),
      inventory_item_id: inventoryItemId,
      available: quantity,
    });
    logger.debug(`Shopify: inventory_item ${inventoryItemId} → ${quantity}`);
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