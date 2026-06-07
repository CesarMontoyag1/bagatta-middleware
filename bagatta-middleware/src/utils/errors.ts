export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly detail?: string,
    public readonly sku?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class ValidationError extends AppError {
  constructor(detail: string) {
    super(400, 'VALIDATION_ERROR', 'Input inválido', detail);
  }
}

export class UnauthorizedError extends AppError {
  constructor(detail?: string) {
    super(401, 'UNAUTHORIZED', 'No autorizado', detail);
  }
}

export class ForbiddenError extends AppError {
  constructor() {
    super(403, 'FORBIDDEN', 'Rol insuficiente para esta operación');
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, sku?: string) {
    super(404, 'NOT_FOUND', `${resource} no encontrado`, undefined, sku);
  }
}

export class ConflictError extends AppError {
  constructor(detail: string) {
    super(409, 'CONFLICT', 'Conflicto', detail);
  }
}

export class SkuMissingError extends AppError {
  constructor() {
    super(422, 'SKU_MISSING', 'Variante sin SKU — no se puede procesar sin clave de sincronización');
  }
}

export class CatchupInProgressError extends AppError {
  constructor() {
    super(503, 'CATCHUP_IN_PROGRESS', 'El orquestador está en modo catchup. Reintenta en unos segundos.');
  }
}
