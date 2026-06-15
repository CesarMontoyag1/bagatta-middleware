import winston from 'winston';

/**
 * Serializa un valor para logging de forma segura.
 * Maneja referencias circulares (como los objetos de error de Axios)
 * sin lanzar excepciones.
 */
function safeStringify(value: unknown): string {
  const seen = new WeakSet();
  return JSON.stringify(
      value,
      (_key, val) => {
        if (typeof val === 'object' && val !== null) {
          if (seen.has(val)) return '[Circular]';
          seen.add(val);
        }
        // Omitir propiedades internas de Axios/Node que no aportan info útil
        if (
            _key === 'socket'      ||
            _key === 'agent'       ||
            _key === 'sockets'     ||
            _key === '_httpMessage'
        ) return '[omitted]';
        return val;
      },
      2,
  );
}

/** Type guard para errores de Axios */
function isAxiosError(val: unknown): val is {
  message:   string;
  isAxiosError: true;
  config?:   { url?: string; method?: string };
  response?: { status?: number; data?: unknown };
} {
  return (
      typeof val === 'object' &&
      val !== null &&
      'isAxiosError' in val &&
      (val as Record<string, unknown>)['isAxiosError'] === true
  );
}

/**
 * Extrae un mensaje legible de cualquier tipo de valor logueable.
 * Si es un Error de Axios, muestra status + data sin estructura circular.
 */
function formatMeta(meta: unknown): string {
  // Sin meta o meta vacío
  if (meta === null || meta === undefined) return '';
  if (typeof meta === 'object' && Object.keys(meta as object).length === 0) return '';

  // Error de Axios — extraer solo lo relevante
  if (isAxiosError(meta)) {
    return safeStringify({
      message: meta.message,
      url:     meta.config?.url,
      method:  meta.config?.method,
      status:  meta.response?.status,
      data:    meta.response?.data,
    });
  }

  // Error estándar de JS
  if (meta instanceof Error) {
    return safeStringify({ message: meta.message, stack: meta.stack });
  }

  return safeStringify(meta);
}

const { combine, timestamp, printf, colorize, errors } = winston.format;

const logFormat = printf((info) => {
  const ts  = (info.timestamp as string).slice(11, 19); // HH:MM:SS
  const lvl = (info.level as string).padEnd(5);

  const reqId = (info['request_id'] as string | undefined)
      ? ` [${info['request_id']}]`
      : '';

  const { timestamp: _ts, level: _lvl, message: _msg, ...rest } = info;
  const metaStr = formatMeta(Object.keys(rest).length > 0 ? rest : undefined);

  return `${ts} [${lvl}]${reqId} ${info.message}${metaStr ? ' ' + metaStr : ''}`;
});

export const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: combine(
      errors({ stack: true }),
      timestamp(),
      process.env.NODE_ENV !== 'production'
          ? combine(colorize({ all: true }), logFormat)
          : logFormat,
  ),
  transports: [
    new winston.transports.Console(),
  ],
});