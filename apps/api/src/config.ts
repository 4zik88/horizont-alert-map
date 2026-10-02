import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1),
  /** Built web app. Resolved from the repo root, where `pnpm start:api` runs. */
  WEB_DIST: z.string().default('apps/web/dist'),
  /**
   * Secure cookies need HTTPS. On by default in production; the local dev server is
   * plain HTTP, where a Secure cookie would silently never be sent back.
   */
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  /** A channel that has not polled successfully for this long is shown as unhealthy. */
  SOURCE_STALE_MS: z.coerce.number().int().positive().default(5 * 20_000),
});

export type Config = z.infer<typeof Env> & { cookieSecure: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    // Names only: values may be secrets.
    const bad = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    console.error(`invalid configuration: ${bad}`);
    process.exit(1);
  }
  const c = parsed.data;
  return {
    ...c,
    cookieSecure: c.COOKIE_SECURE ? c.COOKIE_SECURE === 'true' : c.NODE_ENV === 'production',
  };
}
