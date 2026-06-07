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
            _key === 'socket'   ||
            _key === 'agent'    ||
            _key === 'sockets'  ||
            _key === '_httpMessage'
        ) return '[omitted]';
        return val;
      },
      2,
  );
}

/**
 * Extrae un mensaje legible de cualquier tipo de valor logueable.
 * Si es un Error de Axios, muestra status + data sin estructura circular.
 */
function formatMeta(meta: unknown): string {
  if (!meta || (typeof meta === 'object' && Object.keys(meta as object).length === 0)) {
    return '';
  }

  // Error de Axios — extraer solo lo relevante
  if (
      typeof meta === 'object' &&
      meta !== null &&
      'isAxiosError' in meta &&
      (meta as { isAxiosError: boolean }).isAxiosError
  ) {
    const axiosErr = meta as {
      message:   string;
      config?:   { url?: string; method?: string };
      response?: { status?: number; data?: unknown };
    };
    return safeStringify({
      message:  axiosErr.message,
      url:      axiosErr.config?.url,
      method:   axiosErr.config?.method,
      status:   axiosErr.response?.status,
      data:     axiosErr.response?.data,
    });
  }

  // Error estándar
  if (meta instanceof Error) {
    return safeStringify({ message: meta.message, stack: meta.stack });
  }

  return safeStringify(meta);
}

const { combine, timestamp, printf, colorize, errors } = winston.format;

const logFormat = printf((info) => {
  const ts   = (info.timestamp as string).slice(11, 19); // HH:MM:SS
  const lvl  = (info.level as string).padEnd(5);

  // Extraer el requestId si viene en el meta
  const reqId = (info['request_id'] as string | undefined)
      ? ` [${info['request_id']}]`
      : '';

  // Meta: todo lo que no es timestamp/level/message
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