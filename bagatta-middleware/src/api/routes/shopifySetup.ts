/**
 * src/api/routes/shopifySetup.ts
 *
 * Setup OAuth de Shopify — obtiene el token offline (shpat_) permanente.
 *
 * IMPORTANTE sobre tipos de tokens en Shopify 2026:
 * - atkn_  → Token de automatización del Partners Dashboard. NO sirve para Admin API.
 * - shpat_ → Token offline de OAuth. PERMANENTE. Este es el que necesita el middleware.
 * - Token online → Expira en 24h. Solo para apps que actúan en nombre de usuarios.
 *
 * Este middleware necesita shpat_ (offline). Una vez obtenido no expira.
 */
import { Router, Request, Response } from 'express';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { shopifyTokenManager } from '../../orchestrator/connectors/shopify-auth';
import { shopifyConnector } from '../../orchestrator/connectors/shopify';

const router = Router();

const SCOPES = [
    'read_products',
    'write_products',
    'read_inventory',
    'write_inventory',
    'read_orders',
    'read_product_listings',
].join(',');

// State CSRF en memoria — válido por 10 minutos
let pendingState: { value: string; expiresAt: number } | null = null;

// ── GET /setup/shopify/status ─────────────────────────────────────────────────
// Muestra el estado actual de la conexión con Shopify
router.get('/shopify/status', (_req: Request, res: Response) => {
    const token     = shopifyTokenManager.getToken();
    const isValid   = shopifyTokenManager.isValid();
    const clientId  = process.env.SHOPIFY_CLIENT_ID;
    const hasClient = !!clientId && clientId.length > 10;

    res.json({
        connected:      isValid,
        token_prefix:   token ? token.substring(0, 10) + '...' : 'no configurado',
        token_type:     token?.startsWith('shpat_') ? 'offline (correcto)' : token?.startsWith('atkn_') ? 'automation (inválido para Admin API)' : 'no configurado',
        shop_domain:    env.SHOPIFY_SHOP_DOMAIN,
        has_client_credentials: hasClient,
        next_step: !isValid
            ? hasClient
                ? 'Visita GET /setup/shopify/install para conectar'
                : 'Agrega SHOPIFY_CLIENT_ID y SHOPIFY_CLIENT_SECRET al .env primero'
            : 'Shopify está conectado correctamente',
    });
});

// ── GET /setup/shopify/install ────────────────────────────────────────────────
// Paso 1: Inicia el flujo OAuth redirigiendo a Shopify
router.get('/shopify/install', (req: Request, res: Response) => {
    const force = req.query['force'] === 'true';

    if (shopifyTokenManager.isValid() && !force) {
        res.json({
            message:      'Shopify ya está conectado.',
            token_prefix: shopifyTokenManager.getToken().substring(0, 10) + '...',
            hint:         'Para reconectar usa GET /setup/shopify/install?force=true',
        });
        return;
    }

    const clientId     = process.env.SHOPIFY_CLIENT_ID;
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        res.status(400).json({
            error: 'Faltan credenciales en el .env',
            missing: {
                SHOPIFY_CLIENT_ID:     !clientId     ? 'requerido' : 'ok',
                SHOPIFY_CLIENT_SECRET: !clientSecret ? 'requerido' : 'ok',
            },
            where_to_find: 'Partners Dashboard (dev.shopify.com) → tu app → Configuración → Credenciales',
        });
        return;
    }

    // Generar state anti-CSRF
    const state  = crypto.randomBytes(16).toString('hex');
    pendingState = { value: state, expiresAt: Date.now() + 10 * 60 * 1000 };

    // La redirect URI debe estar registrada en el Partners Dashboard
    const redirectUri = `${env.SELF_URL}/setup/shopify/callback`;

    const authUrl = new URL(`https://${env.SHOPIFY_SHOP_DOMAIN}/admin/oauth/authorize`);
    authUrl.searchParams.set('client_id',     clientId);
    authUrl.searchParams.set('scope',         SCOPES);
    authUrl.searchParams.set('redirect_uri',  redirectUri);
    authUrl.searchParams.set('state',         state);
    authUrl.searchParams.set('grant_options[]', ''); // solicitar token offline (permanente)

    logger.info(`Shopify OAuth: redirigiendo → ${authUrl.toString()}`);
    logger.info(`Redirect URI configurada: ${redirectUri}`);
    logger.info('⚠️  Asegúrate de que esta URL esté en "Allowed redirection URLs" del Partners Dashboard');

    res.redirect(authUrl.toString());
});

// ── GET /setup/shopify/callback ───────────────────────────────────────────────
// Paso 2: Shopify redirige aquí tras el consentimiento
router.get('/shopify/callback', async (req: Request, res: Response) => {
    const { code, state, shop, hmac } = req.query as Record<string, string>;

    // ── Validar state anti-CSRF ──────────────────────────────────────────────
    if (!pendingState || pendingState.value !== state || Date.now() > pendingState.expiresAt) {
        res.status(400).json({
            error: 'State inválido o expirado',
            hint:  'Vuelve a GET /setup/shopify/install e intenta de nuevo',
        });
        return;
    }
    pendingState = null;

    // ── Validar que el shop coincide ─────────────────────────────────────────
    if (shop !== env.SHOPIFY_SHOP_DOMAIN) {
        res.status(400).json({
            error:    `Shop no coincide`,
            expected: env.SHOPIFY_SHOP_DOMAIN,
            received: shop,
        });
        return;
    }

    // ── Validar HMAC del callback ────────────────────────────────────────────
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
    if (hmac && clientSecret) {
        const message = Object.entries(req.query as Record<string, string>)
            .filter(([k]) => k !== 'hmac')
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`)
            .join('&');

        const expected = crypto.createHmac('sha256', clientSecret).update(message).digest('hex');

        if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expected))) {
            res.status(401).json({ error: 'HMAC del callback no válido' });
            return;
        }
    }

    if (!code) {
        res.status(400).json({ error: 'No se recibió code de autorización' });
        return;
    }

    try {
        logger.info('Shopify OAuth: intercambiando code por access token...');

        const { data } = await axios.post(
            `https://${env.SHOPIFY_SHOP_DOMAIN}/admin/oauth/access_token`,
            {
                client_id:     process.env.SHOPIFY_CLIENT_ID,
                client_secret: process.env.SHOPIFY_CLIENT_SECRET,
                code,
            },
        );

        const accessToken: string = data.access_token;
        const scopes: string      = data.scope;

        if (!accessToken) {
            res.status(500).json({ error: 'No se recibió access_token en la respuesta de Shopify' });
            return;
        }

        if (accessToken.startsWith('atkn_')) {
            res.status(500).json({
                error: 'Se recibió un automation token (atkn_) en lugar de un access token offline (shpat_)',
                hint:  'Verifica que tu app en el Partners Dashboard tiene los scopes correctos y que el flujo OAuth es para una tienda, no para la organización',
            });
            return;
        }

        logger.info(`✅  Token Shopify obtenido: ${accessToken.substring(0, 10)}... | Scopes: ${scopes}`);

        // ── Guardar en .env ──────────────────────────────────────────────────
        const envPath = path.resolve(process.cwd(), '.env');
        if (fs.existsSync(envPath)) {
            let content = fs.readFileSync(envPath, 'utf-8');

            if (content.includes('SHOPIFY_ACCESS_TOKEN=')) {
                content = content.replace(
                    /SHOPIFY_ACCESS_TOKEN=["']?[^"'\r\n]*["']?/,
                    `SHOPIFY_ACCESS_TOKEN="${accessToken}"`,
                );
            } else {
                content += `\nSHOPIFY_ACCESS_TOKEN="${accessToken}"\n`;
            }

            fs.writeFileSync(envPath, content, 'utf-8');
            logger.info('✅  SHOPIFY_ACCESS_TOKEN guardado en .env');
        }

        // ── Actualizar en memoria sin reiniciar ──────────────────────────────
        shopifyTokenManager.setToken(accessToken);

        // ── Verificar conexión inmediatamente ────────────────────────────────
        let shopInfo: { name: string; domain: string } | null = null;
        try {
            shopInfo = await shopifyConnector.verifyConnection();
        } catch {
            logger.warn('No se pudo verificar la conexión tras el OAuth (no es crítico)');
        }

        res.json({
            success:      true,
            message:      '✅  Shopify conectado correctamente',
            token_prefix: accessToken.substring(0, 10) + '...',
            token_type:   accessToken.startsWith('shpat_') ? 'offline (permanente)' : 'otro',
            scopes,
            shop:         shopInfo,
            next_steps: [
                'El token fue guardado en .env y activado en memoria automáticamente',
                'NO necesitas reiniciar el servidor — el polling ya usa el nuevo token',
                'Verifica la conexión en GET /setup/shopify/verify',
            ],
        });

    } catch (err) {
        const axErr = err as { response?: { status?: number; data?: unknown }; message?: string };
        logger.error('Shopify OAuth callback error:', err);
        res.status(500).json({
            error:  'Error al intercambiar el code',
            status: axErr.response?.status,
            detail: axErr.response?.data ?? axErr.message,
        });
    }
});

// ── GET /setup/shopify/verify ─────────────────────────────────────────────────
router.get('/shopify/verify', async (_req: Request, res: Response) => {
    if (!shopifyTokenManager.isValid()) {
        res.status(400).json({
            valid:  false,
            error:  'Token no válido',
            action: 'Visita GET /setup/shopify/install',
        });
        return;
    }

    try {
        const shop = await shopifyConnector.verifyConnection();
        res.json({
            valid:        true,
            shop_name:    shop.name,
            shop_domain:  shop.domain,
            token_prefix: shopifyTokenManager.getToken().substring(0, 10) + '...',
            message:      '✅  Shopify conectado y respondiendo correctamente',
        });
    } catch (err) {
        const axErr = err as { response?: { status?: number; data?: unknown } };
        res.status(400).json({
            valid:  false,
            status: axErr.response?.status,
            detail: axErr.response?.data,
            action: 'El token puede haber sido revocado. Visita GET /setup/shopify/install?force=true',
        });
    }
});

export default router;