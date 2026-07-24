import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';

/**
 * Caché en memoria de la metadata "casi-estática" del catálogo — lo que
 * prácticamente nunca cambia entre ventas (SKU, IDs externos, costo).
 *
 * Por qué existe: fastAlegraSync y fastShopifySync corren cada 30-60s, y
 * antes cada uno traía el catálogo COMPLETO (con columnas de texto, fechas,
 * nombres) desde Supabase en cada corrida — esto disparó el egress del plan
 * gratuito a 147% en 11 días. La solución no es solo "traer menos columnas"
 * (eso sigue escalando con la cantidad de SKUs × frecuencia de polling),
 * sino dejar de retransmitir por completo lo que no cambió.
 *
 * El stock (lo único que sí cambia seguido) NO se cachea aquí a propósito —
 * se sigue leyendo directo de master_inventory en cada ciclo, con un select
 * mínimo. Cachear también el stock sería más rápido, pero introduce riesgo
 * real: si alguien corrige el stock manualmente en la base de datos (algo
 * que ya pasó varias veces durante las pruebas de este proyecto), la caché
 * en memoria no se enteraría hasta el próximo refresco — y compararía contra
 * un valor viejo, generando el mismo tipo de "delta fantasma" que ya
 * corregimos una vez. Cachear solo lo verdaderamente estático evita ese riesgo.
 */

export interface CatalogCacheEntry {
    sku:                     string;
    shopifyInventoryItemId:  string | null;
    alegraItemId:            string;
    lastKnownCost:           number;
}

class CatalogCache {
    private cache = new Map<string, CatalogCacheEntry>();
    private lastFullRefresh: Date | null = null;

    /** Recarga completa desde Supabase — solo columnas necesarias, sin joins pesados. */
    async refresh(): Promise<void> {
        const rows = await prisma.productCatalog.findMany({
            where:  { status: 'active' },
            select: {
                sku:                    true,
                shopifyInventoryItemId: true,
                alegraItemId:           true,
                lastKnownCost:          true,
            },
        });

        const next = new Map<string, CatalogCacheEntry>();
        for (const row of rows) {
            next.set(row.sku, {
                sku:                    row.sku,
                shopifyInventoryItemId: row.shopifyInventoryItemId,
                alegraItemId:           row.alegraItemId,
                lastKnownCost:          row.lastKnownCost.toNumber(),
            });
        }

        this.cache = next;
        this.lastFullRefresh = new Date();
        logger.info(`CatalogCache: refresco completo — ${this.cache.size} SKUs activos en memoria`);
    }

    getAll(): CatalogCacheEntry[] {
        return Array.from(this.cache.values());
    }

    get(sku: string): CatalogCacheEntry | undefined {
        return this.cache.get(sku);
    }

    /** Actualiza (o agrega) una entrada tras un cambio propio — evita esperar
     * al refresco periódico para que un producto nuevo/editado sea visible. */
    upsert(entry: CatalogCacheEntry): void {
        this.cache.set(entry.sku, entry);
    }

    remove(sku: string): void {
        this.cache.delete(sku);
    }

    get size(): number {
        return this.cache.size;
    }

    get lastRefreshAt(): Date | null {
        return this.lastFullRefresh;
    }
}

export const catalogCache = new CatalogCache();