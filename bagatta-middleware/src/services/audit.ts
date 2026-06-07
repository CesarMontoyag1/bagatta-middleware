import { AuditField, AuditOrigin } from '@prisma/client';
import { prisma } from '../db/prisma';
import { sseService } from './sse';
import { logger } from '../utils/logger';
import { buildIdempotencyKey } from '../utils/idempotency';

interface AuditEntry {
  idempotencyKey: string;
  sku:            string;
  fieldChanged:   AuditField;
  oldValue:       string | null;
  newValue:       string;
  origin:         AuditOrigin;
  sourceEventRef?: string;
  alertTriggered?: boolean;
}

class AuditService {
  /**
   * Inserta una entrada en el audit_log.
   * Idempotente: si la idempotency_key ya existe, retorna null sin error.
   * NUNCA hace UPDATE ni DELETE — es append-only.
   */
  async log(entry: AuditEntry): Promise<string | null> {
    try {
      const record = await prisma.auditLog.create({
        data: {
          idempotencyKey: entry.idempotencyKey,
          sku:            entry.sku,
          fieldChanged:   entry.fieldChanged,
          oldValue:       entry.oldValue,
          newValue:       entry.newValue,
          origin:         entry.origin,
          sourceEventRef: entry.sourceEventRef,
          alertTriggered: entry.alertTriggered ?? false,
        },
        select: { id: true },
      });
      return record.id;
    } catch (err: unknown) {
      // P2002 = unique constraint violation → ya procesado, es OK (idempotencia BD)
      if ((err as { code?: string }).code === 'P2002') {
        logger.debug(`AuditLog: idempotency skip para key: ${entry.idempotencyKey}`);
        return null;
      }
      logger.error('AuditLog: error al insertar entrada', err);
      throw err;
    }
  }

  /**
   * Registra un cambio de stock.
   */
  async logStockChange(params: {
    sku:            string;
    oldStock:       number;
    newStock:       number;
    origin:         AuditOrigin;
    sourceEventRef: string;
    alert?:         boolean;
  }): Promise<string | null> {
    const key = buildIdempotencyKey(params.origin, params.sourceEventRef, 'stock');
    return this.log({
      idempotencyKey: key,
      sku:            params.sku,
      fieldChanged:   'stock',
      oldValue:       String(params.oldStock),
      newValue:       String(params.newStock),
      origin:         params.origin,
      sourceEventRef: params.sourceEventRef,
      alertTriggered: params.alert ?? false,
    });
  }

  /**
   * Registra un cambio de precio.
   * Si el origen es alegra_polling → genera alerta automática (precio modificado fuera del flujo).
   */
  async logPriceChange(params: {
    sku:            string;
    oldPrice:       number;
    newPrice:       number;
    origin:         AuditOrigin;
    sourceEventRef: string;
  }): Promise<string | null> {
    const isAlegraOrigin = params.origin === 'alegra_polling';
    const key = buildIdempotencyKey(params.origin, params.sourceEventRef, 'price');

    const id = await this.log({
      idempotencyKey: key,
      sku:            params.sku,
      fieldChanged:   'price',
      oldValue:       String(params.oldPrice),
      newValue:       String(params.newPrice),
      origin:         params.origin,
      sourceEventRef: params.sourceEventRef,
      alertTriggered: isAlegraOrigin,
    });

    if (isAlegraOrigin && id) {
      await this.createAlert({
        type:       'price_conflict',
        sku:        params.sku,
        detail:     `Precio modificado en Alegra (${params.oldPrice} → ${params.newPrice}). ` +
            `Shopify es master. Revertido automáticamente.`,
        auditLogId: id,
      });
    }

    return id;
  }

  /**
   * Registra un cambio de costo.
   * El costo tiene impacto contable directo → se loguea siempre.
   */
  async logCostChange(params: {
    sku:            string;
    oldCost:        number;
    newCost:        number;
    origin:         AuditOrigin;
    sourceEventRef: string;
  }): Promise<string | null> {
    const isAlegraOrigin = params.origin === 'alegra_polling';
    const key = buildIdempotencyKey(params.origin, params.sourceEventRef, 'cost');

    const id = await this.log({
      idempotencyKey: key,
      sku:            params.sku,
      fieldChanged:   'cost',
      oldValue:       String(params.oldCost),
      newValue:       String(params.newCost),
      origin:         params.origin,
      sourceEventRef: params.sourceEventRef,
      alertTriggered: isAlegraOrigin,
    });

    if (isAlegraOrigin && id) {
      await this.createAlert({
        type:       'cost_conflict',
        sku:        params.sku,
        detail:     `Costo modificado en Alegra (${params.oldCost} → ${params.newCost}). ` +
            `Shopify es master. Revertido automáticamente. ` +
            `Verifica el impacto en márgenes contables.`,
        auditLogId: id,
      });
    }

    return id;
  }

  /**
   * Crea una alerta visible en el dashboard y la emite por SSE.
   */
  async createAlert(params: {
    type:       string;
    sku?:       string;
    detail:     string;
    auditLogId?: string;
  }): Promise<void> {
    try {
      const alert = await prisma.alert.create({
        data: {
          type:       params.type as never,
          sku:        params.sku,
          detail:     params.detail,
          auditLogId: params.auditLogId,
        },
        select: { id: true, type: true },
      });

      sseService.emitAlert(alert.type, params.sku ?? null, params.detail, alert.id);
      logger.warn(`Alerta creada [${alert.type}] SKU: ${params.sku ?? 'N/A'} — ${params.detail}`);
    } catch (err) {
      // No propagar errores de alerta — nunca deben interrumpir el flujo principal
      logger.error('Error creando alerta:', err);
    }
  }
}

export const auditService = new AuditService();