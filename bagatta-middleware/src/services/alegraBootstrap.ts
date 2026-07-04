import { alegraConnector } from '../orchestrator/connectors/alegra';
import { logger } from '../utils/logger';
import { env } from '../config/env';

/**
 * IDs y cuentas contables resueltos en tiempo de arranque.
 * Se pueblan una sola vez y se usan en todo el sistema.
 */
interface AlegraRuntimeIds {
    categoryId:      string;
    warehouseId:     string;
    accountTemplate: AlegraAccountTemplate | null;
}

/**
 * Cuentas contables copiadas de un ítem existente.
 * Los nombres internos corresponden a las claves del bloque "accounting"
 * que devuelve y acepta la API de Alegra.
 */
export interface AlegraAccountTemplate {
    inventoryAccount?: { id: string | number };  // → accounting.inventory (string)
    saleCost?:         { id: string | number };  // → accounting.inventariablePurchase (string)
    saleIncome?:       { id: string | number };  // → category (cuenta contable ingresos)
    tax?:              { id: string | number };  // → tax[] (array)
    priceListId?:      string | number;          // → price[0].idPriceList (UUID en Alegra Colombia)
    unit?:             string;                   // → inventory.unit (ej: "unit", no "Unidad")
}

let resolved: AlegraRuntimeIds | null = null;

export async function bootstrapAlegraIds(
    categoryName: string,
    warehouseName: string,
): Promise<AlegraRuntimeIds> {
    if (resolved) return resolved;

    logger.info('Resolviendo IDs de Alegra por nombre...');

    const categoryId      = await resolveCategory(categoryName);
    const warehouseId     = await resolveWarehouse(warehouseName);
    const accountTemplate = await resolveAccountTemplate();

    resolved = { categoryId, warehouseId, accountTemplate };

    logger.info(
        `✅  Alegra IDs resueltos — categoría: "${categoryName}" → ${categoryId} | ` +
        `bodega: "${warehouseName}" → ${warehouseId} | ` +
        `cuentas contables: ${accountTemplate ? 'OK' : 'no encontradas (creación puede fallar)'}`,
    );

    return resolved;
}

export function getAlegraIds(): AlegraRuntimeIds {
    if (!resolved) {
        throw new Error(
            'AlegraBootstrap: getAlegraIds() llamado antes de bootstrapAlegraIds(). ' +
            'Asegúrate de llamar bootstrapAlegraIds() en el arranque del servidor.',
        );
    }
    return resolved;
}

// ── Helpers internos ──────────────────────────────────────────────────────────

async function resolveCategory(name: string): Promise<string> {
    let categories: Array<{ id: string; name: string; status: string }> = [];

    try {
        categories = await alegraConnector.listCategories();
    } catch (err) {
        logger.error('Error consultando categorías de Alegra:', err);
        throw new Error(
            `No se pudo conectar con Alegra para resolver la categoría "${name}". ` +
            'Verifica ALEGRA_USER_EMAIL y ALEGRA_API_TOKEN en el .env.',
        );
    }

    const match = categories.find(
        (c) => c.name.trim().toLowerCase() === name.trim().toLowerCase() && c.status === 'active',
    );

    if (!match) {
        const available = categories.map((c) => `"${c.name}"`).join(', ');
        throw new Error(
            `Categoría "${name}" no encontrada en Alegra. ` +
            `Categorías disponibles: ${available || 'ninguna'}. ` +
            `Crea la categoría en Alegra → Configuración → Categorías y vuelve a arrancar.`,
        );
    }

    return String(match.id);
}

async function resolveWarehouse(name: string): Promise<string> {
    let warehouses: Array<{ id: string; name: string; status: string; isDefault: boolean }> = [];

    try {
        warehouses = await alegraConnector.listWarehouses();
    } catch (err) {
        logger.error('Error consultando bodegas de Alegra:', err);
        throw new Error(
            `No se pudo conectar con Alegra para resolver la bodega "${name}". ` +
            'Verifica ALEGRA_USER_EMAIL y ALEGRA_API_TOKEN en el .env.',
        );
    }

    let match = warehouses.find(
        (w) => w.name.trim().toLowerCase() === name.trim().toLowerCase() && w.status === 'active',
    );

    if (!match) {
        match = warehouses.find((w) => w.isDefault && w.status === 'active');
        if (match) {
            logger.warn(
                `Bodega "${name}" no encontrada. Usando bodega por defecto: "${match.name}" (${match.id})`,
            );
        }
    }

    if (!match) {
        const available = warehouses.map((w) => `"${w.name}"`).join(', ');
        throw new Error(
            `Bodega "${name}" no encontrada en Alegra y no hay bodega por defecto activa. ` +
            `Bodegas disponibles: ${available || 'ninguna'}.`,
        );
    }

    return String(match.id);
}

/**
 * Obtiene las cuentas contables para nuevos ítems de Alegra.
 *
 * Estrategia en orden de prioridad:
 *  1. Variables de entorno ALEGRA_*_ACCOUNT_ID (configuración explícita)
 *  2. Primer ítem activo existente en Alegra (copia automática)
 *  3. null → la creación puede fallar con error 1008
 */
async function resolveAccountTemplate(): Promise<AlegraAccountTemplate | null> {

    // ── Prioridad 1: variables de entorno ─────────────────────────────────
    const fromEnv = buildTemplateFromEnv();
    if (fromEnv) {
        logger.info(
            `Cuentas contables cargadas desde .env: ${Object.keys(fromEnv).join(', ')}`,
        );
        return fromEnv;
    }

    // ── Prioridad 2: copiar de un ítem existente ──────────────────────────
    try {
        const item = await alegraConnector.getFirstActiveItem();

        if (!item) {
            logger.warn(
                'No hay ítems existentes en Alegra para usar como plantilla de cuentas. ' +
                'Agrega ALEGRA_INVENTORY_ACCOUNT_ID, ALEGRA_SALE_COST_ACCOUNT_ID y ' +
                'ALEGRA_SALE_INCOME_ACCOUNT_ID al .env.',
            );
            return null;
        }


        // Descomentar para un posible debug futuro.
        // Log temporal para diagnosticar los nombres exactos de campos que devuelve Alegra
        //logger.info(`[Bootstrap:debug] Ítem plantilla raw: ${JSON.stringify(item)}`);

        const account: AlegraAccountTemplate = {};

        const extract = (field: unknown): { id: string | number } | undefined => {
            if (field && typeof field === 'object') {
                const f = field as { id?: string | number };
                if (f.id !== undefined) return { id: f.id };
            }
            return undefined;
        };

        // La API de Alegra devuelve las cuentas bajo "accounting", no en el nivel raíz:
        //   accounting.inventory             → cuenta de inventario (inventoryAccount)
        //   accounting.inventariablePurchase → costo de ventas      (saleCost)
        // La cuenta de ingresos (saleIncome) aparece en "category" cuando no está
        // explícita en accounting — se toma de ahí como fallback.
        const accounting = item['accounting'] as Record<string, unknown> | undefined;

        const inv  = extract(accounting?.['inventory']);
        const cost = extract(accounting?.['inventariablePurchase']);
        // saleIncome: buscar primero en accounting, luego en category como fallback
        const incAccounting = extract(accounting?.['income'] ?? accounting?.['sale']);
        const incCategory   = extract(item['category']);
        const inc           = incAccounting ?? incCategory;

        // tax en Alegra es un array — tomar el primero si existe
        const taxArr = Array.isArray(item['tax']) ? item['tax'] as unknown[] : [];
        const tax    = taxArr.length > 0 ? extract(taxArr[0]) : undefined;

        if (inv)  account.inventoryAccount = inv;
        if (cost) account.saleCost         = cost;
        if (inc)  account.saleIncome       = inc;
        if (tax)  account.tax              = tax;

        // Extraer el ID de la lista de precios principal del ítem plantilla.
        // En Alegra Colombia el idPriceList es un UUID, no el entero 1.
        const priceArr = Array.isArray(item['price']) ? item['price'] as Array<Record<string, unknown>> : [];
        const mainPrice = priceArr.find((p) => p['main'] === true) ?? priceArr[0];
        if (mainPrice?.['idPriceList']) {
            account.priceListId = mainPrice['idPriceList'] as string | number;
        }

        // Extraer la unidad de medida del ítem plantilla.
        // ALEGRA_UNIT_OF_MEASURE del .env puede no coincidir con el código interno
        // que acepta la API (ej: "Unidad" → rechazado, "unit" → aceptado).
        const inventoryObj = item['inventory'] as Record<string, unknown> | undefined;
        if (typeof inventoryObj?.['unit'] === 'string' && inventoryObj['unit']) {
            account.unit = inventoryObj['unit'];
        }

        const mainKeys = ['inventoryAccount', 'saleCost', 'saleIncome'];
        const found    = mainKeys.filter((k) => k in account).length;

        if (found > 0) {
            logger.info(
                `Plantilla contable obtenida del ítem "${item['name'] ?? item['id']}": ` +
                `${Object.keys(account).join(', ')}`,
            );
            return account;
        }

        // El ítem existe pero no tiene cuentas — indicar cómo resolverlo
        logger.warn(
            `Ítem ${item['id']} encontrado pero sin cuentas contables. ` +
            `Agrega estas variables al .env para resolverlo:\n` +
            `  ALEGRA_INVENTORY_ACCOUNT_ID=<id cuenta inventario>\n` +
            `  ALEGRA_SALE_COST_ACCOUNT_ID=<id cuenta costo ventas>\n` +
            `  ALEGRA_SALE_INCOME_ACCOUNT_ID=<id cuenta ingresos>\n` +
            `Consulta los IDs en: https://api.alegra.com/api/v1/accounts`,
        );
        return null;

    } catch (err) {
        logger.warn('No se pudo obtener plantilla contable de Alegra:', err);
        return null;
    }
}

/**
 * Construye la plantilla contable desde variables de entorno.
 * Retorna null si ninguna está configurada.
 */
function buildTemplateFromEnv(): AlegraAccountTemplate | null {
    const inv  = env.ALEGRA_INVENTORY_ACCOUNT_ID;
    const cost = env.ALEGRA_SALE_COST_ACCOUNT_ID;
    const inc  = env.ALEGRA_SALE_INCOME_ACCOUNT_ID;

    if (!inv && !cost && !inc) return null;

    const account: AlegraAccountTemplate = {};
    if (inv)  account.inventoryAccount = { id: inv };
    if (cost) account.saleCost         = { id: cost };
    if (inc)  account.saleIncome       = { id: inc };
    return account;
}