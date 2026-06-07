import { Response } from 'express';
import { SseEvent, SseEventType } from '../types';
import { logger } from '../utils/logger';

interface SseClient {
  id: string;
  res: Response;
  connectedAt: Date;
}

class SseService {
  private clients: Map<string, SseClient> = new Map();

  /**
   * Registra una nueva conexión SSE.
   * Configura los headers y mantiene la conexión abierta.
   */
  addClient(id: string, res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Nginx buffering off
    res.flushHeaders();

    // Enviar comentario inicial para confirmar conexión
    res.write(': connected\n\n');

    this.clients.set(id, { id, res, connectedAt: new Date() });
    logger.debug(`SSE: cliente conectado (${id}). Total: ${this.clients.size}`);

    // Limpiar cuando el cliente se desconecta
    res.on('close', () => {
      this.clients.delete(id);
      logger.debug(`SSE: cliente desconectado (${id}). Total: ${this.clients.size}`);
    });
  }

  /**
   * Emite un evento a todos los clientes conectados.
   */
  broadcast(event: SseEvent): void {
    if (this.clients.size === 0) return;

    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;

    for (const [id, client] of this.clients) {
      try {
        client.res.write(payload);
      } catch {
        // Cliente desconectado sin disparar 'close' — limpiamos
        this.clients.delete(id);
      }
    }
  }

  /**
   * Envía heartbeat a todos los clientes para mantener la conexión.
   * Se llama desde el cron cada 30s.
   */
  heartbeat(): void {
    const data: SseEvent = {
      type: 'heartbeat',
      data: { ts: new Date().toISOString() },
    };
    this.broadcast(data);
  }

  /**
   * Helpers para cada tipo de evento del sistema.
   */
  emitSyncTick(skusChecked: number, deltasApplied: number, status: string): void {
    this.broadcast({
      type: 'sync_tick',
      data: { ts: new Date().toISOString(), status, skus_checked: skusChecked, deltas: deltasApplied },
    });
  }

  emitAlert(type: string, sku: string | null, detail: string, alertId: string): void {
    this.broadcast({
      type: 'alert',
      data: { id: alertId, type, sku, detail, ts: new Date().toISOString() },
    });
  }

  emitConflictResolved(sku: string, oldStock: number, newStock: number, deltaShopify: number, deltaAlegra: number): void {
    this.broadcast({
      type: 'conflict_resolved',
      data: { sku, old_stock: oldStock, new_stock: newStock, delta_shopify: deltaShopify, delta_alegra: deltaAlegra, ts: new Date().toISOString() },
    });
  }

  emitCatchupStart(gapMinutes: number, from: Date): void {
    this.broadcast({
      type: 'catchup_start',
      data: { gap_minutes: gapMinutes, from: from.toISOString(), ts: new Date().toISOString() },
    });
  }

  emitCatchupEnd(skusReconciled: number, durationMs: number): void {
    this.broadcast({
      type: 'catchup_end',
      data: { skus_reconciled: skusReconciled, duration_ms: durationMs, ts: new Date().toISOString() },
    });
  }

  get clientCount(): number {
    return this.clients.size;
  }
}

// Singleton
export const sseService = new SseService();

export function emitEvent(type: SseEventType, data: Record<string, unknown>): void {
  sseService.broadcast({ type, data });
}
