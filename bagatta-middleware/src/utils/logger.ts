import winston from 'winston';
import { env } from '../config/env';

const { combine, timestamp, printf, colorize, json } = winston.format;

const devFormat = printf(({ level, message, timestamp, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${timestamp} [${level}] ${message}${metaStr}`;
});

export const logger = winston.createLogger({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  format:
    env.NODE_ENV === 'production'
      ? combine(timestamp(), json())
      : combine(colorize(), timestamp({ format: 'HH:mm:ss' }), devFormat),
  transports: [new winston.transports.Console()],
});
