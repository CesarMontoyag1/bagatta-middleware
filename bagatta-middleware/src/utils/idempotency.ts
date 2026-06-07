import { v4 as uuidv4 } from 'uuid';

/**
 * Genera una idempotency key estándar para operaciones del orquestador.
 * Formato: {origin}:{sourceRef}:{field}
 * Ejemplo: orchestrator:so_12345:stock
 */
export function buildIdempotencyKey(
  origin: string,
  sourceRef: string,
  field: string,
): string {
  return `${origin}:${sourceRef}:${field}`.substring(0, 128);
}

/**
 * Genera un request ID único para correlación de logs.
 */
export function generateRequestId(): string {
  return uuidv4();
}
