/**
 * Rate limiter tipo "token bucket": permite ráfagas cortas hasta `burst`,
 * pero fuerza que el promedio sostenido no supere `ratePerSecond`.
 *
 * Uso: antes de cada request a una API externa con límite conocido,
 * `await limiter.acquire()` — se resuelve inmediatamente si hay tokens
 * disponibles, o espera lo necesario para no exceder el límite.
 */
export class TokenBucketLimiter {
    private tokens: number;
    private lastRefill: number;

    constructor(
        private readonly ratePerSecond: number,
        private readonly burst: number = ratePerSecond,
    ) {
        this.tokens = burst;
        this.lastRefill = Date.now();
    }

    private refill(): void {
        const now = Date.now();
        const elapsedSeconds = (now - this.lastRefill) / 1000;
        this.tokens = Math.min(this.burst, this.tokens + elapsedSeconds * this.ratePerSecond);
        this.lastRefill = now;
    }

    async acquire(): Promise<void> {
        this.refill();
        if (this.tokens >= 1) {
            this.tokens -= 1;
            return;
        }
        // No hay tokens: esperar lo necesario para generar uno y reintentar
        const waitMs = ((1 - this.tokens) / this.ratePerSecond) * 1000;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        return this.acquire();
    }
}