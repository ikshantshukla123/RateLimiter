import pino from 'pino';

export const logger =
  process.env.NODE_ENV === 'test'
    ? pino({ level: 'silent' })
    : pino({ level: process.env.LOG_LEVEL ?? 'info' });

export type Logger = typeof logger;
