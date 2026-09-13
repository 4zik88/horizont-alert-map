import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import type { Repo } from '../db/repo.js';
import { logger } from '../logger.js';
import type { MapApi } from './api.js';
import { grantSession, hasValidCookie, isConfigured, isValidToken } from './auth.js';

export interface ServerOptions {
  port: number;
  pollIntervalMs: number;
  publicDir: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * The one HTTP surface: health, the map, and the map's data.
 *
 * Everything except `/healthz` and `/robots.txt` sits behind the map token. The token
 * appears once, in the path, and is immediately exchanged for an httpOnly cookie —
 * keeping it out of `Referer` headers and access logs. Anything unauthorised gets a
 * flat 404, so the server never confirms that a valid link exists.
 */
export function startServer(repo: Repo, api: MapApi | undefined, opts: ServerOptions): Server {
  const root = resolve(opts.publicDir);

  const server = createServer((req, res) => {
    handle(req, res, repo, api, opts, root).catch((error) => {
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
  api: MapApi | undefined,
  opts: ServerOptions,
  root: string,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = decodeURIComponent(url.pathname);

  if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res);

  // Railway's healthcheck must work without the token.
  if (path === '/healthz') {
    const health = checkHealth(repo, opts.pollIntervalMs);
    return json(res, health.ok ? 200 : 503, health, 'no-store');
  }

  // The map is private and must never be indexed, even if a link escapes.
  if (path === '/robots.txt') {
    res.writeHead(200, { 'content-type': MIME['.txt']!, 'x-robots-tag': 'noindex, nofollow' });
    res.end('User-agent: *\nDisallow: /\n');
    return;
  }

  if (!isConfigured()) return notFound(res);

  // /t/<token> exchanges the secret for a cookie, then redirects to a clean URL so
  // the token is never in the address bar, history, or an outgoing Referer.
  const tokenMatch = /^\/t\/([A-Za-z0-9_-]{8,128})\/?$/.exec(path);
  if (tokenMatch) {
    if (!isValidToken(tokenMatch[1]!)) return notFound(res);
    return grantSession(res, '/');
  }

  if (!hasValidCookie(req)) return notFound(res);

  // Injected rather than hardcoded, so the basemap can be swapped for a keyed
  // provider by setting env vars, with no code change.
  if (path === '/config.js') {
    res.writeHead(200, { 'content-type': MIME['.js']!, 'cache-control': 'private, no-cache' });
    res.end(
      `window.HZ_CONFIG=${JSON.stringify({
        tileUrl: process.env['MAP_TILE_URL'] ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        tileAttribution: process.env['MAP_TILE_ATTRIBUTION'] ?? '&copy; OpenStreetMap',
        tileMaxZoom: Number(process.env['MAP_TILE_MAX_ZOOM'] ?? 18),
        darkenTiles: (process.env['MAP_TILE_DARKEN'] ?? '1') === '1',
      })};`,
    );
    return;
  }

  if (path === '/api/state') {
    if (!api) return notFound(res);
    // Short cache: the page polls, and a stale second is harmless.
    return json(res, 200, api.state(), 'private, max-age=5');
  }

  return serveStatic(res, root, path === '/' ? '/index.html' : path);
}

function serveStatic(res: ServerResponse, root: string, requested: string): void {
  // Resolve, then verify the result is still inside the public directory: this is
  // what stops `/../../etc/passwd` and its encoded variants.
  const target = resolve(join(root, normalize(requested)));
  if (target !== root && !target.startsWith(root + '/')) return notFound(res);
  if (!existsSync(target) || !statSync(target).isFile()) return notFound(res);

  const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream';
  // The shell is revalidated every load so a deploy is picked up; data files are
  // versioned by content and can be cached longer.
  const cache = target.endsWith('.geojson') ? 'private, max-age=86400' : 'private, no-cache';

  res.writeHead(200, {
    'content-type': type,
    'cache-control': cache,
    'x-robots-tag': 'noindex, nofollow, noarchive',
    // Origin only, never the path: tile servers block unidentified referrers, and
    // the map token lives in a cookie rather than the URL so nothing secret travels.
    'referrer-policy': 'strict-origin',
    'x-content-type-options': 'nosniff',
  });
  createReadStream(target).pipe(res);
}

function json(res: ServerResponse, status: number, body: unknown, cache: string): void {
  res.writeHead(status, {
    'content-type': MIME['.json']!,
    'cache-control': cache,
    'x-robots-tag': 'noindex, nofollow',
    'referrer-policy': 'strict-origin',
  });
  res.end(JSON.stringify(body));
}

/** Flat 404 for everything unauthorised — never 403, which would confirm a secret exists. */
function notFound(res: ServerResponse): void {
  res.writeHead(404, { 'content-type': MIME['.txt']!, 'cache-control': 'no-store' });
  res.end('Not found\n');
}

/**
 * Unhealthy when any enabled channel has not succeeded within five poll intervals, so
 * a silently dead poller is restarted rather than left looking alive.
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

  return { ok: channels.length > 0 && channels.every((c) => c.fresh), channels };
}
