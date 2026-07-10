/**
 * Ejecuta `fn` sobre cada elemento de `items`, con un máximo de `concurrency`
 * llamadas en vuelo al mismo tiempo — en vez de esperar a que cada una termine
 * antes de empezar la siguiente (secuencial) ni lanzarlas todas a la vez
 * (podría saturar de rate limits a Shopify/Alegra).
 *
 * No usamos una librería externa (como p-limit) para evitar problemas de
 * compatibilidad ESM/CommonJS en este proyecto — esta implementación es
 * suficiente para el caso de uso (decenas/cientos de SKUs, no miles).
 */
export async function mapWithConcurrency<T>(
    items: T[],
    concurrency: number,
    fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
    let cursor = 0;

    async function worker(): Promise<void> {
        while (cursor < items.length) {
            const index = cursor++;
            await fn(items[index], index);
        }
    }

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
    await Promise.all(workers);
}