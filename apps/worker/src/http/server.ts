import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Repo } from '../db/repo.js';
import { logger } from '../logger.js';

export interface ServerOptions {
  port: number;
  pollIntervalMs: number;
}

/**
 * The health endpoint, and nothing else.
 *
 * This used to serve a Leaflet map behind a secret-link token. The map is gone: the
 * tool warns by Telegram, using the location the reader shared with the bot, and a web
 * page was a second surface to keep correct — its own auth, its own cookie jar
 * problems on iOS, its own rendering rules — for information the bot already delivers
 * to the phone that is already in their hand.
 *
 * What remains exists because Railway restarts a container whose healthcheck fails,
 * which is how a silently dead poller gets noticed.
 */
export function startServer(repo: Repo, opts: ServerOptions): Server {
  const server = createServer((req, res) => {
    handle(req, res, repo, opts).catch((error: unknown) => {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'request failed',
      );
      if (!res.headersSent) res.writeHead(500).end();
    });
  });

  server.listen(opts.port, () => logger.info({ port: opts.port }, 'http listening'));
  return server;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  opts: ServerOptions,
): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;

  if ((req.method === 'GET' || req.method === 'HEAD') && path === '/healthz') {
    const health = await checkHealth(repo, opts.pollIntervalMs);
    res.writeHead(health.ok ? 200 : 503, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(health));
    return;
  }

  // Everything else is 404, including the map's old paths. Nothing here is public.
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end('Not found\n');
}

/**
 * Unhealthy when any enabled channel has not succeeded within five poll intervals, so
 * a silently dead poller is restarted rather than left looking alive.
 */
export async function checkHealth(repo: Repo, pollIntervalMs: number) {
  const staleAfter = pollIntervalMs * 5;
  const now = Date.now();

  const channels = (await repo.listChannels())
    .filter((c) => c.enabled === 1)
    .map((c) => ({
      channel: c.channel,
      lastSuccessAt: c.lastSuccessAt,
      lastMessageId: c.lastMessageId,
      consecutiveFailures: c.consecutiveFailures,
      fresh: c.lastSuccessAt !== null && now - c.lastSuccessAt < staleAfter,
    }));

  return { ok: channels.length > 0 && channels.every((c) => c.fresh), channels };
}
