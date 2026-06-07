import { alegraConnector } from '../orchestrator/connectors/alegra';
import { logger } from '../utils/logger';

/**
 * IDs resueltos en tiempo de arranque.
 * Se pueblan una sola vez en bootstrap() y se usan en todo el sistema.
 * No son variables de entorno — el sistema las descubre automáticamente por nombre.
 */
interface AlegraRuntimeIds {
    categoryId:  string;
    warehouseId: string;
}

let resolved: AlegraRuntimeIds | null = null;

/**
 * Resuelve el ID de la categoría de sincronización y el ID de la bodega
 * consultando la API de Alegra por sus nombres configurados.
 *
 * Se llama una sola vez al arrancar el servidor (en src/index.ts).
 * Si falla, el proceso termina — sin estos IDs el sistema no puede crear
 * ítems en Alegra correctamente.
 */
export async function bootstrapAlegraIds(
    categoryName: string,
    warehouseName: string,
): Promise<AlegraRuntimeIds> {
    if (resolved) return resolved;

    logger.info('Resolviendo IDs de Alegra por nombre...');

    // ── Categoría ──────────────────────────────────────────────────────────────
    const categoryId = await resolveCategory(categoryName);

    // ── Bodega ─────────────────────────────────────────────────────────────────
    const warehouseId = await resolveWarehouse(warehouseName);

    resolved = { categoryId, warehouseId };

    logger.info(
        `✅  Alegra IDs resueltos — categoría: "${categoryName}" → ${categoryId} | ` +
        `bodega: "${warehouseName}" → ${warehouseId}`,
    );

    return resolved;
}

/**
 * Devuelve los IDs ya resueltos.
 * Lanza si se llama antes de bootstrapAlegraIds().
 */
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

    // Intentar por nombre primero
    let match = warehouses.find(
        (w) => w.name.trim().toLowerCase() === name.trim().toLowerCase() && w.status === 'active',
    );

    // Si no hay match por nombre, usar la bodega por defecto
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