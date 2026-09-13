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
    .default('kpszsu,KozakChornobay,sectorv666,monikppy')
    .transform(csv)
    .refine((v) => v.length > 0, 'CHANNELS must list at least one channel'),

  POLL_INTERVAL_MS: z.coerce.number().int().min(5_000).default(20_000),
  POLL_JITTER_PCT: z.coerce.number().min(0).max(1).default(0.15),
  FETCH_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(10_000),
  MAX_BACKOFF_MS: z.coerce.number().int().min(10_000).default(300_000),
  GAP_FILL_MAX_PAGES: z.coerce.number().int().min(0).max(200).default(25),

  PARSE_BATCH_SIZE: z.coerce.number().int().min(1).max(2000).default(200),
  PARSE_INTERVAL_MS: z.coerce.number().int().min(1_000).default(10_000),
  // Hard ceiling on Claude calls per batch so an unusual day cannot run up a bill.
  LLM_BUDGET_PER_BATCH: z.coerce.number().int().min(0).max(500).default(20),

  // 'auto' picks Groq if GROQ_API_KEY is set, else Anthropic if its key is set,
  // else rules-only. Name a provider explicitly to override.
  LLM_PROVIDER: z.enum(['auto', 'groq', 'anthropic', 'none']).default('auto'),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(20_000),

  GROQ_API_KEY: z.string().optional(),
  // Groq rotates its catalogue; `npm run llm:check` lists what your key can use.
  GROQ_MODEL: z.string().default('llama-3.3-70b-versatile'),

  // Consumed in later steps. Declared here so the shape is known and `.env.example`
  // stays honest, but never required — step 1 runs with zero secrets configured.
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-6'),
  // Step 3. Without a bot token the bot and notifier simply do not start; ingest
  // and parsing continue, so the service stays deployable with no secrets at all.
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  ALLOWED_CHAT_IDS: z.string().optional(),
  ALLOWED_USERNAMES: z.string().optional(),
  BOT_POLL_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(60).default(30),

  NOTIFY_INTERVAL_MS: z.coerce.number().int().min(1_000).default(15_000),
  NOTIFY_COOLDOWN_MS: z.coerce.number().int().min(0).default(300_000),
  NOTIFY_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.6),
  NOTIFY_MAX_AGE_MS: z.coerce.number().int().min(60_000).default(1_800_000),
  NOTIFY_COURSE_TOLERANCE_DEG: z.coerce.number().min(1).max(90).default(30),
  NOTIFY_LEAD_MINUTES: z.coerce.number().min(1).max(180).default(25),

  // 'auto' uses alerts.in.ua's tokened API when a token is set, and its public
  // situation report otherwise — so alerts are correct with no signup at all.
  ALERTS_PROVIDER: z
    .enum(['auto', 'alerts_in_ua_public', 'alerts_com_ua', 'alerts_in_ua'])
    .default('auto'),
  ALERTS_IN_UA_TOKEN: z.string().optional(),
  ALERTS_POLL_INTERVAL_MS: z.coerce.number().int().min(5_000).default(15_000),

  // Step 4. Without MAP_TOKEN the map is not served at all; `npm run map:token`
  // generates one.
  MAP_TOKEN: z.string().optional(),
  PUBLIC_DIR: z.string().default('./public'),
  MAP_TARGET_WINDOW_MS: z.coerce.number().int().min(60_000).default(3_600_000),
  MAP_FEED_LIMIT: z.coerce.number().int().min(10).max(500).default(120),
});

export type Config = z.infer<typeof schema>;

/** Env vars that must never appear in a log line, a boot banner, or an error. */
const SECRET_KEYS = [
  'GROQ_API_KEY',
  'TELEGRAM_BOT_TOKEN',
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
    if ((SECRET_KEYS as readonly string[]).includes(key)) continue;
    out[key] = value;
  }

  // Listed explicitly: an unset optional is absent from the parsed object entirely,
  // so iterating it alone would silently omit the secrets rather than report them
  // as unset — exactly when you most want to see which ones are missing.
  for (const key of SECRET_KEYS) {
    const value = config[key];
    out[key] = value === undefined || value === '' ? '[unset]' : '[set]';
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
