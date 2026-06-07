import axios, { AxiosInstance } from 'axios';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { ShopifyProduct, ShopifyInventoryLevel } from '../../types';

class ShopifyConnector {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: `https://${env.SHOPIFY_SHOP_DOMAIN}/admin/api/${env.SHOPIFY_API_VERSION}`,
      headers: {
        'X-Shopify-Access-Token': env.SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });

    this.client.interceptors.response.use(
        (r) => r,
        (err) => {
          const status = err.response?.status;
          const url    = err.config?.url;
          logger.error(`Shopify API error ${status} en ${url}`, { data: err.response?.data });
          throw err;
        },
    );
  }

  // ── Productos ────────────────────────────────────────────────────────────────

  async getProduct(productId: string): Promise<ShopifyProduct> {
    const { data } = await this.client.get(`/products/${productId}.json`);
    return data.product as ShopifyProduct;
  }

  async listProducts(sinceId?: string): Promise<ShopifyProduct[]> {
    const params: Record<string, string> = { limit: '250' };
    if (sinceId) params.since_id = sinceId;
    const { data } = await this.client.get('/products.json', { params });
    return data.products as ShopifyProduct[];
  }

  // ── Inventario ───────────────────────────────────────────────────────────────

  async getInventoryLevel(inventoryItemId: number): Promise<number> {
    const { data } = await this.client.get('/inventory_levels.json', {
      params: {
        inventory_item_ids: inventoryItemId,
        location_ids:       env.SHOPIFY_LOCATION_ID,
      },
    });
    const level = (data.inventory_levels as ShopifyInventoryLevel[])[0];
    return level?.available ?? 0;
  }

  /**
   * Ajusta el inventario de una variante en Shopify.
   * Usa `set` (valor absoluto) para garantizar consistencia — no `adjust` (relativo).
   */
  async setInventoryLevel(inventoryItemId: number, quantity: number): Promise<void> {
    await this.client.post('/inventory_levels/set.json', {
      location_id:       parseInt(env.SHOPIFY_LOCATION_ID, 10),
      inventory_item_id: inventoryItemId,
      available:         quantity,
    });
    logger.debug(`Shopify: inventory_item ${inventoryItemId} → ${quantity}`);
  }

  /**
   * Actualiza el precio de una variante.
   */
  async updateVariantPrice(variantId: string, price: string): Promise<void> {
    await this.client.put(`/variants/${variantId}.json`, {
      variant: { id: variantId, price },
    });
    logger.debug(`Shopify: variant ${variantId} precio → ${price}`);
  }

  /**
   * Obtiene el cost por item de una variante leyendo el InventoryItem.
   * El costo no viene en el payload de webhook — requiere una llamada adicional.
   * Devuelve 0 si no está disponible o el campo no está en los permisos.
   */
  async getVariantCost(inventoryItemId: number): Promise<number> {
    try {
      const { data } = await this.client.get(`/inventory_items/${inventoryItemId}.json`);
      const cost = data.inventory_item?.cost;
      return cost ? parseFloat(cost) : 0;
    } catch (err) {
      logger.warn(`Shopify: no se pudo obtener costo de inventory_item ${inventoryItemId}`, err);
      return 0;
    }
  }

  /**
   * Obtiene todas las órdenes creadas después de `createdAtMin`.
   * Pagina automáticamente usando cursor-based pagination de Shopify.
   * Usado en polling y catchup sync para calcular deltas de venta.
   */
  async getOrdersSince(createdAtMin: Date): Promise<Array<{
    id: number;
    name: string;
    created_at: string;
    line_items: Array<{ variant_id: number; sku: string; quantity: number }>;
  }>> {
    const allOrders: Array<{
      id: number;
      name: string;
      created_at: string;
      line_items: Array<{ variant_id: number; sku: string; quantity: number }>;
    }> = [];

    let pageInfo: string | undefined;
    let isFirstPage = true;

    while (true) {
      const params: Record<string, string> = {
        status:         'any',
        limit:          '250',
        fields:         'id,name,created_at,line_items',
        financial_status: 'paid',
      };

      if (isFirstPage) {
        params.created_at_min = createdAtMin.toISOString();
        isFirstPage = false;
      } else if (pageInfo) {
        params.page_info = pageInfo;
      } else {
        break; // no hay más páginas
      }

      const { data, headers } = await this.client.get('/orders.json', { params });
      const orders = data.orders ?? [];
      allOrders.push(...orders);

      // Extraer cursor de paginación del header Link
      const linkHeader = headers['link'] as string | undefined;
      pageInfo = this.extractNextPageInfo(linkHeader);

      if (!pageInfo || orders.length < 250) break;
    }

    return allOrders;
  }

  /**
   * Extrae el page_info del header Link de Shopify.
   * Formato: <url?page_info=xxx>; rel="next"
   */
  private extractNextPageInfo(linkHeader?: string): string | undefined {
    if (!linkHeader) return undefined;
    const match = linkHeader.match(/<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/);
    return match ? match[1] : undefined;
  }

  /**
   * Obtiene el inventory_item_id de una variante.
   * Necesario para llamar a inventory_levels y getVariantCost.
   */
  async getVariantInventoryItemId(variantId: string): Promise<number> {
    const { data } = await this.client.get(`/variants/${variantId}.json`);
    return data.variant.inventory_item_id as number;
  }
}

export const shopifyConnector = new ShopifyConnector();