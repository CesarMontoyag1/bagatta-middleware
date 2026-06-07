/**
 * src/orchestrator/connectors/shopify-auth.ts
 *
 * Gestión del access token de Shopify para el middleware.
 *
 * Shopify en el Partners Dashboard (dev.shopify.com) usa OAuth 2.0.
 * El token OFFLINE (shpat_) es permanente — no expira cada 24h.
 * El token que expira cada 24h es el ONLINE (de sesión de usuario), que
 * NO es el que necesita un middleware de backend.
 *
 * Flujo correcto para este middleware:
 *   1. Primera vez: GET /setup/shopify/install → OAuth → shpat_ guardado en .env
 *   2. Siempre: usar ese shpat_ directamente — no hay renovación automática necesaria
 *   3. Si el token falla (401): loguear alerta y detener el polling
 *
 * El token se lee desde process.env en tiempo de ejecución para que el setup
 * pueda actualizarlo en memoria sin reiniciar el servidor.
 */
import { logger } from '../../utils/logger';

class ShopifyTokenManager {
    private static instance: ShopifyTokenManager;
    private _token: string = '';
    private _isValid: boolean = false;

    private constructor() {
        // Leer el token inicial desde el entorno
        this._token = process.env.SHOPIFY_ACCESS_TOKEN ?? '';
        this._isValid = this.validateTokenFormat(this._token);

        if (!this._isValid) {
            logger.warn(
                '⚠️  SHOPIFY_ACCESS_TOKEN no configurado o inválido. ' +
                'Visita http://localhost:3000/setup/shopify/install para conectar Shopify.',
            );
        }
    }

    static getInstance(): ShopifyTokenManager {
        if (!ShopifyTokenManager.instance) {
            ShopifyTokenManager.instance = new ShopifyTokenManager();
        }
        return ShopifyTokenManager.instance;
    }

    /**
     * Devuelve el token actual.
     * Lee desde process.env en cada llamada para capturar actualizaciones
     * realizadas por el setup OAuth sin necesidad de reiniciar.
     */
    getToken(): string {
        // Re-leer desde process.env para capturar tokens actualizados por el setup
        const envToken = process.env.SHOPIFY_ACCESS_TOKEN ?? '';
        if (envToken !== this._token) {
            this._token   = envToken;
            this._isValid = this.validateTokenFormat(envToken);
            if (this._isValid) {
                logger.info('✅  Shopify token actualizado en memoria desde setup OAuth');
            }
        }
        return this._token;
    }

    /**
     * Actualiza el token manualmente (llamado por el setup OAuth tras obtener el shpat_).
     */
    setToken(token: string): void {
        this._token                         = token;
        this._isValid                       = this.validateTokenFormat(token);
        process.env['SHOPIFY_ACCESS_TOKEN'] = token;
        logger.info(`✅  Shopify token configurado: ${token.substring(0, 10)}...`);
    }

    /**
     * Verifica si el token tiene el formato correcto de un token offline de Shopify.
     * Los tokens offline tienen el prefijo shpat_.
     * Los atkn_ son tokens de automatización del Partners Dashboard — no sirven para Admin API.
     */
    isValid(): boolean {
        return this.validateTokenFormat(this.getToken());
    }

    /**
     * Marca el token como inválido tras recibir un 401 de Shopify.
     * Detiene el polling hasta que se configure un token válido.
     */
    markInvalid(): void {
        this._isValid = false;
        logger.error(
            '❌  Token de Shopify inválido (401). Polling detenido para Shopify. ' +
            'Visita http://localhost:3000/setup/shopify/install para reconfigurar.',
        );
    }

    private validateTokenFormat(token: string): boolean {
        if (!token || token.trim() === '') return false;
        if (token.startsWith('atkn_'))        return false; // automation token — no sirve
        if (token.startsWith('PLACEHOLDER'))  return false;
        if (token.startsWith('shpat_'))       return true;  // token offline correcto
        // Aceptar otros formatos por si Shopify cambia el prefijo en el futuro
        return token.length > 20;
    }
}

export const shopifyTokenManager = ShopifyTokenManager.getInstance();

/**
 * Helper para obtener el token actual desde cualquier parte del sistema.
 * Compatible con el flujo anterior que usaba getShopifyAccessToken().
 */
export async function getShopifyAccessToken(): Promise<string> {
    const token = shopifyTokenManager.getToken();
    if (!token) {
        throw new Error(
            'Shopify no está configurado. Visita /setup/shopify/install para conectar tu tienda.',
        );
    }
    return token;
}