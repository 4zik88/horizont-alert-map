import { createServer, type Server } from 'node:http';
import type { Repo } from '../db/repo.js';
import { logger } from '../logger.js';

export interface ServerOptions {
  port: number;
  pollIntervalMs: number;
}

/**
 * Step 1 serves only /healthz. It exists this early for three reasons: Railway needs a
 * healthcheck target, being a web service from day one means the domain and port config
 * never change, and step 4's static map plus /api routes hang off this same file.
 */
export function startServer(repo: Repo, opts: ServerOptions): Server {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url?.split('?')[0] !== '/healthz') {
      res.writeHead(404).end();
      return;
    }

    const health = checkHealth(repo, opts.pollIntervalMs);
    res.writeHead(health.ok ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify(health));
  });

  server.listen(opts.port, () => logger.info({ port: opts.port }, 'http listening'));
  return server;
}

/**
 * Unhealthy when any enabled channel has not succeeded within five poll intervals, so
 * a poller that has silently stopped polling gets restarted instead of lingering —
 * the worst failure mode for an alerting tool is looking alive while delivering nothing.
 */
export function checkHealth(repo: Repo, pollIntervalMs: number) {
  const staleAfter = pollIntervalMs * 5;
  const now = Date.now();

  const channels = repo.listChannels()
    .filter((c) => c.enabled === 1)
    .map((c) => ({
      channel: c.channel,
      lastSuccessAt: c.lastSuccessAt,
      lastMessageId: c.lastMessageId,
      consecutiveFailures: c.consecutiveFailures,
      fresh: c.lastSuccessAt !== null && now - c.lastSuccessAt < staleAfter,
    }));

  return {
    ok: channels.length > 0 && channels.every((c) => c.fresh),
    channels,
  };
}
