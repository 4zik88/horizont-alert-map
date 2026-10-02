import { pino } from 'pino';
import { config } from './config.js';

/**
 * Paths scrubbed from every log record. User coordinates and Telegram identities are
 * the hard constraint: they live in the database and nowhere else. Wiring this up in step 1
 * — before any user row exists — means a stray `log.info({ user })` in step 3 cannot
 * leak them.
 *
 * Message text is deliberately NOT redacted: it is public channel content, and being
 * able to see it at debug level is how the step-2 parser gets debugged against real
 * traffic.
 */
const REDACT_PATHS = [
  'lat', 'lon', 'chat_id', 'chatId', 'token',
  '*.lat', '*.lon', '*.chat_id', '*.chatId', '*.token',
  'user.lat', 'user.lon', 'user.chat_id', 'user.chatId', 'user.username',
];

export const logger = pino({
  level: config.LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(config.NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
    : {}),
});

export type Logger = typeof logger;
