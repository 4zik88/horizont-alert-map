import { z } from 'zod';

const csv = (s: string): string[] =>
  s.split(',').map((v) => v.trim()).filter((v) => v.length > 0);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  PORT: z.coerce.number().int().positive().default(8080),

  DB_PATH: z.string().min(1).default('./data/app.db'),

  CHANNELS: z
    .string()
    .default('kpszsu,KozakChornobay,sectorv666')
    .transform(csv)
    .refine((v) => v.length > 0, 'CHANNELS must list at least one channel'),

  POLL_INTERVAL_MS: z.coerce.number().int().min(5_000).default(20_000),
  POLL_JITTER_PCT: z.coerce.number().min(0).max(1).default(0.15),
  FETCH_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(10_000),
  MAX_BACKOFF_MS: z.coerce.number().int().min(10_000).default(300_000),
  GAP_FILL_MAX_PAGES: z.coerce.number().int().min(0).max(200).default(25),

  // Consumed in later steps. Declared here so the shape is known and `.env.example`
  // stays honest, but never required — step 1 runs with zero secrets configured.
  ANTHROPIC_API_KEY: z.string().optional(),       // step 2
  ANTHROPIC_MODEL: z.string().optional(),         // step 2
  TELEGRAM_BOT_TOKEN: z.string().optional(),      // step 3
  ALLOWED_CHAT_IDS: z.string().optional(),        // step 3
  ALLOWED_USERNAMES: z.string().optional(),       // step 3
  ALERTS_IN_UA_TOKEN: z.string().optional(),      // step 4
  MAP_TOKEN: z.string().optional(),               // step 4
});

export type Config = z.infer<typeof schema>;

/** Env vars that must never appear in a log line, a boot banner, or an error. */
const SECRET_KEYS = [
  'ANTHROPIC_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'ALERTS_IN_UA_TOKEN',
  'MAP_TOKEN',
  'ALLOWED_CHAT_IDS',
  'ALLOWED_USERNAMES',
] as const satisfies readonly (keyof Config)[];

function load(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    // Deliberately console.error, not the logger: config must be valid before the
    // logger is built, and a misconfigured process should die loudly and readably.
    console.error(`Invalid environment configuration:\n${issues}`);
    process.exit(1);
  }
  return parsed.data;
}

export const config: Config = load();

/**
 * Boot-safe view of the config: secrets collapse to '[set]'/'[unset]' so the value
 * itself can never reach a log sink.
 */
export function redactedConfig(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    out[key] = (SECRET_KEYS as readonly string[]).includes(key)
      ? value === undefined || value === '' ? '[unset]' : '[set]'
      : value;
  }
  return out;
}

/**
 * Read an env var that a later step depends on, failing with a message that says
 * which step needs it rather than a bare undefined.
 */
export function requireEnv<K extends keyof Config>(key: K, step: string): NonNullable<Config[K]> {
  const value = config[key];
  if (value === undefined || value === '') {
    throw new Error(`${step} requires ${String(key)} to be set (see .env.example)`);
  }
  return value as NonNullable<Config[K]>;
}
