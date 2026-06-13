import { shopifyConnector } from '../orchestrator/connectors/shopify';
import { logger } from '../utils/logger';

/**
 * IDs de Shopify resueltos en tiempo de arranque.
 * Se pueblan una sola vez en bootstrapShopifyIds() y se usan en todo el sistema
 * a través de getShopifyLocationId().
 */
interface ShopifyRuntimeIds {
    locationId: string;
}

let resolved: ShopifyRuntimeIds | null = null;

/**
 * Resuelve el location_id de la tienda automáticamente.
 *
 * Estrategia de selección, en orden de prioridad:
 *   1. Si SHOPIFY_LOCATION_NAME está definido en .env → buscar por ese nombre exacto.
 *   2. Si hay una sola location activa → usarla (caso típico de tiendas pequeñas).
 *   3. Si hay varias → usar la marcada como `active: true` con menor id,
 *      y loguear advertencia listando todas para que el usuario pueda
 *      configurar SHOPIFY_LOCATION_NAME si no es la correcta.
 *
 * Se llama una sola vez al arrancar (en src/index.ts), igual que bootstrapAlegraIds.
 * Si Shopify aún no está autenticado (token no configurado), no falla el arranque —
 * se reintentará la próxima vez que se necesite getShopifyLocationId().
 */
export async function bootstrapShopifyIds(locationName?: string): Promise<ShopifyRuntimeIds | null> {
    if (resolved) return resolved;

    logger.info('Resolviendo location_id de Shopify automáticamente...');

    let locations: Array<{ id: number; name: string; active: boolean }>;
    try {
        locations = await shopifyConnector.listLocations();
    } catch (err) {
        logger.warn(
            `No se pudo resolver la location de Shopify todavía (${(err as Error).message}). ` +
            'Se reintentará cuando Shopify esté autenticado. ' +
            'Visita /setup/shopify/install si aún no conectaste la tienda.',
        );
        return null;
    }

    if (locations.length === 0) {
        throw new Error('Shopify no devolvió ninguna location. Verifica la configuración de la tienda.');
    }

    const activeLocations = locations.filter((l) => l.active);
    const pool = activeLocations.length > 0 ? activeLocations : locations;

    let chosen: { id: number; name: string; active: boolean } | undefined;

    // 1. Por nombre, si fue configurado
    if (locationName) {
        chosen = pool.find((l) => l.name.trim().toLowerCase() === locationName.trim().toLowerCase());
        if (!chosen) {
            logger.warn(
                `SHOPIFY_LOCATION_NAME="${locationName}" no coincide con ninguna location. ` +
                `Disponibles: ${pool.map((l) => `"${l.name}"`).join(', ')}. Usando fallback automático.`,
            );
        }
    }

    // 2. Única location activa
    if (!chosen && pool.length === 1) {
        chosen = pool[0];
    }

    // 3. Varias — tomar la de menor id y advertir
    if (!chosen) {
        chosen = [...pool].sort((a, b) => a.id - b.id)[0];
        if (pool.length > 1) {
            logger.warn(
                `Shopify tiene ${pool.length} locations activas. Usando "${chosen.name}" (id=${chosen.id}) por defecto. ` +
                `Si no es la correcta, define SHOPIFY_LOCATION_NAME en .env. ` +
                `Disponibles: ${pool.map((l) => `"${l.name}" (id=${l.id})`).join(', ')}`,
            );
        }
    }

    resolved = { locationId: String(chosen.id) };

    logger.info(`✅  Shopify location resuelta: "${chosen.name}" → ${chosen.id}`);

    return resolved;
}

/**
 * Devuelve el location_id ya resuelto.
 * Si aún no se resolvió (ej: Shopify no estaba autenticado al arrancar),
 * lanza un error descriptivo — los conectores deben manejar esto o
 * llamarse después de un bootstrap exitoso.
 */
export function getShopifyLocationId(): string {
    // 1. Valor resuelto dinámicamente (fuente de verdad definitiva)
    if (resolved) return resolved.locationId;

    // 2. Fallback: SHOPIFY_LOCATION_ID en .env (puede ser GID o numérico)
    const envId = process.env.SHOPIFY_LOCATION_ID ?? '';
    if (envId) {
        // Normalizar GID si es necesario
        const normalized = envId.startsWith('gid://')
            ? envId.split('/').pop()!
            : envId;
        if (normalized) {
            // Cachear para que el siguiente ciclo no pase por aquí
            resolved = { locationId: normalized };
            return normalized;
        }
    }

    // 3. Sin valor disponible — lanzar con mensaje claro
    throw new Error(
        'Shopify location no resuelta. Opciones:\n' +
        '  a) Agrega read_locations a los scopes de tu app en partners.shopify.com y vuelve a autenticar\n' +
        '  b) Define SHOPIFY_LOCATION_ID="115702923627" en el .env como fallback temporal\n' +
        '  c) Visita /setup/shopify/install para reautenticar con los scopes correctos',
    );
}

/**
 * Indica si la location ya fue resuelta — útil para checks sin lanzar.
 */
export function hasShopifyLocationId(): boolean {
    return resolved !== null;
}

/**
 * Fuerza un location_id específico en memoria, sobrescribiendo cualquier
 * valor previo. Usado por getInventoryLevel cuando detecta que el location_id
 * configurado no tiene el item y encuentra uno mejor automáticamente.
 */
export function overrideShopifyLocationId(locationId: string): void {
    resolved = { locationId };
    logger.info(`✅  Shopify location corregida automáticamente → ${locationId}`);
}

/**
 * Permite forzar la re-resolución (ej: tras completar el OAuth en /setup/shopify/callback,
 * cuando el bootstrap inicial no pudo resolverla por falta de token).
 */
export function resetShopifyBootstrap(): void {
    resolved = null;
}