import axios, { AxiosInstance, AxiosError } from 'axios';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { ShopifyProduct, ShopifyInventoryLevel } from '../../types';
import { shopifyTokenManager } from './shopify-auth';
import { getShopifyLocationId } from '../../services/shopifyBootstrap';

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

  /**
   * Obtiene el stock disponible de un inventory_item en la location configurada.
   * Si no encuentra nivel en esa location, busca en TODAS las locations y
   * actualiza el bootstrap con el location_id correcto automáticamente.
   */
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