import axios, { AxiosInstance } from 'axios';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { AlegraItem, AlegraItemCreatePayload, AlegraMovement } from '../../types';
import { getAlegraIds } from '../../services/alegraBootstrap';

class AlegraConnector {
  private client: AxiosInstance;

  constructor() {
    const credentials = Buffer.from(
        `${env.ALEGRA_USER_EMAIL}:${env.ALEGRA_API_TOKEN}`,
    ).toString('base64');

    this.client = axios.create({
      baseURL: 'https://api.alegra.com/api/v1',
      headers: {
        Authorization:  `Basic ${credentials}`,
        'Content-Type': 'application/json',
      },
      timeout: 20000,
    });

    this.client.interceptors.response.use(
        (r) => r,
        (err) => {
          const status = err.response?.status;
          const url    = err.config?.url;
          logger.error(`Alegra API error ${status} en ${url}`, { data: err.response?.data });
          throw err;
        },
    );
  }

  // ── Bootstrap — autodescubrimiento de IDs ────────────────────────────────

  async listCategories(): Promise<Array<{ id: string; name: string; status: string }>> {
    const { data } = await this.client.get('/item-categories');
    return (data ?? []) as Array<{ id: string; name: string; status: string }>;
  }

  async listWarehouses(): Promise<Array<{
    id: string; name: string; status: string; isDefault: boolean;
  }>> {
    const { data } = await this.client.get('/warehouses');
    return (data ?? []) as Array<{ id: string; name: string; status: string; isDefault: boolean }>;
  }

  // ── Items ────────────────────────────────────────────────────────────────

  async createItem(payload: AlegraItemCreatePayload): Promise<AlegraItem> {
    const { data } = await this.client.post('/items', payload);
    logger.info(`Alegra: ítem creado → id=${data.id}, ref=${data.reference}`);
    return data as AlegraItem;
  }

  async getItem(alegraItemId: string): Promise<AlegraItem> {
    const { data } = await this.client.get(`/items/${alegraItemId}`);
    return data as AlegraItem;
  }

  /**
   * Busca un ítem por su campo `reference` (= SKU de Shopify).
   * Usado para recuperar la vinculación cuando product_catalog se vació
   * pero el ítem ya existe en Alegra (Alegra rechaza referencias duplicadas).
   * Devuelve null si no se encuentra ninguno.
   */
  async findItemByReference(reference: string): Promise<AlegraItem | null> {
    const { data } = await this.client.get('/items', {
      params: { reference, limit: 1 },
    });
    const items = data as AlegraItem[];
    return items.length > 0 ? items[0] : null;
  }

  /**
   * Devuelve el primer ítem activo de Alegra con sus cuentas contables.
   * Usado en el bootstrap para obtener la plantilla de cuentas (error 1008).
   */
  async getFirstActiveItem(): Promise<Record<string, unknown> | null> {
    const { data } = await this.client.get('/items', {
      params: {
        limit:  1,
        start:  0,
        type:   'product',
        fields: 'id,name,inventoryAccount,saleCost,saleIncome,tax,status',
      },
    });
    const items = Array.isArray(data) ? data as Record<string, unknown>[] : [];
    return items.find((it) => it['status'] === 'active') ?? items[0] ?? null;
  }

  async getSyncedItems(): Promise<AlegraItem[]> {
    const { categoryId } = getAlegraIds();
    const allItems: AlegraItem[] = [];
    let start = 0;
    const limit = 30;

    while (true) {
      const { data } = await this.client.get('/items', {
        params: { start, limit, type: 'product' },
      });
      const page = data as AlegraItem[];
      if (!page || page.length === 0) break;

      const synced = page.filter(
          (item: AlegraItem & { category?: { id: string | number } }) =>
              String(item.category?.id) === categoryId,
      );
      allItems.push(...synced);

      if (page.length < limit) break;
      start += limit;
    }

    return allItems;
  }

  /**
   * Ajusta el stock de un ítem en Alegra mediante un inventory-adjustment.
   *
   * Alegra requiere el campo `type` para distinguir entrada vs salida:
   *   - type: "positive" → ENTRADA de inventario (quantity debe ser positivo)
   *   - type: "negative" → SALIDA de inventario (quantity debe ser positivo también,
   *                          el signo lo da el `type`, no el número)
   *
   * `delta` aquí puede ser positivo o negativo según la dirección del cambio
   * calculado por el orquestador. Esta función traduce ese delta al formato
   * que Alegra espera: type correcto + quantity siempre positivo (valor absoluto).
   *
   * Si delta === 0 no hace nada (no se debe llamar, pero por seguridad no falla).
   */
  async adjustStock(alegraItemId: string, delta: number, reason: string): Promise<void> {
    if (delta === 0) {
      logger.debug(`Alegra: adjustStock con delta=0 para ítem ${alegraItemId}. Omitido.`);
      return;
    }

    const { warehouseId } = getAlegraIds();
    const type     = delta > 0 ? 'in' : 'out';
    const quantity = Math.abs(delta);

    const payload = {
      date:        new Date().toISOString().split('T')[0],
      description: reason,
      warehouse:   { id: warehouseId },
      items: [
        {
          id:       alegraItemId,   // ID directo, no anidado en { item: { id } }
          type:     delta > 0 ? 'in' : 'out',  // Alegra acepta 'in' o 'out'
          quantity,
          unitCost: 0,             // requerido por Alegra aunque sea 0
        },
      ],
    };

    logger.debug(`Alegra adjustStock payload: ${JSON.stringify(payload)}`);

    const { data } = await this.client.post('/inventory-adjustments', payload);
    logger.info(
        `Alegra: ajuste inventario ítem ${alegraItemId} → ${type} ${quantity} (delta=${delta}) | ` +
        `Respuesta id=${data?.id ?? 'N/A'}`,
    );
  }

  async updateItemPrice(alegraItemId: string, price: number): Promise<void> {
    await this.client.put(`/items/${alegraItemId}`, {
      price: [{ idPriceList: 1, price }],
    });
    logger.debug(`Alegra: ítem ${alegraItemId} precio → ${price}`);
  }

  async updateItemCost(alegraItemId: string, cost: number): Promise<void> {
    await this.client.put(`/items/${alegraItemId}`, {
      inventory: { unitCost: cost },
    });
    logger.debug(`Alegra: ítem ${alegraItemId} costo → ${cost}`);
  }

  async updateItemName(alegraItemId: string, name: string): Promise<void> {
    await this.client.put(`/items/${alegraItemId}`, { name });
    logger.debug(`Alegra: ítem ${alegraItemId} nombre → ${name}`);
  }

  async updateItemReference(alegraItemId: string, newSku: string): Promise<void> {
    await this.client.put(`/items/${alegraItemId}`, { reference: newSku });
    logger.debug(`Alegra: ítem ${alegraItemId} referencia → ${newSku}`);
  }

  async archiveItem(alegraItemId: string, currentName: string): Promise<void> {
    const archivedName = currentName.startsWith('[INACTIVO]')
        ? currentName
        : `[INACTIVO] ${currentName}`;

    await this.client.put(`/items/${alegraItemId}`, {
      status: 'inactive',
      name:   archivedName,
    });
    logger.info(`Alegra: ítem ${alegraItemId} archivado → "${archivedName}"`);
  }

  async getInventoryMovementsSince(since: Date): Promise<AlegraMovement[]> {
    const startStr = since.toISOString().split('T')[0];
    const endStr   = new Date().toISOString().split('T')[0];

    try {
      const { data } = await this.client.get('/inventory-adjustments', {
        params: {
          'dateRange[start]': startStr,
          'dateRange[end]':   endStr,
          limit:              500,
          start:              0,
        },
      });
      return (data ?? []) as AlegraMovement[];
    } catch (err) {
      logger.error('Alegra: error consultando inventory-adjustments', err);
      return [];
    }
  }
}

export const alegraConnector = new AlegraConnector();