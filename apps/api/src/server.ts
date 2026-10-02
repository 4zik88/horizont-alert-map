import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import compress from '@fastify/compress';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { HISTORY_MS, type ClientMessage, type Me, type Snapshot } from '@horizont/contract';
import {
  alertsAt, appendEvent, consumeLogin, countPushSubscriptions, deletePushSubscription,
  savePushSubscription, createSession, deleteSession, latestSeq, pruneAuth,
  pruneEvents, sessionUser, sourceStatuses, SESSION_TTL_MS, tracksAt, type SessionUser, type Sql,
} from '@horizont/db';
import { geoDataPath } from '@horizont/geo/node';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { Hub } from './hub.js';
import type { Config } from './config.js';

export const SESSION_COOKIE = 'hz_session';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

export interface ServerDeps {
  sql: Sql;
  config: Pick<Config, 'cookieSecure' | 'WEB_DIST' | 'SOURCE_STALE_MS' | 'LOG_LEVEL' | 'NODE_ENV'> & {
    VAPID_PUBLIC_KEY?: string | undefined;
  };
  now?: () => number;
  /** Tests turn the request log off. */
  logger?: boolean;
}

/*
 * The CSP spells out the only places the page may reach: itself and the keyless
 * OpenFreeMap tiles. MapLibre runs its workers from blob: URLs and sets inline styles.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://tiles.openfreemap.org",
  "connect-src 'self' https://tiles.openfreemap.org",
  "worker-src 'self' blob:",
  "font-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

/*
 * The browser vendors' push services. The worker POSTs to whatever endpoint is stored,
 * so an arbitrary HTTPS URL would let a session aim it at any host, internal ones
 * included. Chrome/Edge (FCM, WNS), Firefox (autopush) and Safari (Apple) cover every
 * browser this app supports.
 */
const PUSH_HOSTS = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'web.push.apple.com',
  'notify.windows.com',
];
export function isPushService(hostname: string): boolean {
  return PUSH_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`));
}

/** Login secrets travel in URLs; they must never reach a log line. */
const scrubUrl = (url: string) => url.replace(/([?&]t=)[^&]*/g, '$1[redacted]');

const escapeAttr = (v: string) =>
  v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A page with one button. No script, so the CSP needs no exception for it. */
function confirmPage(token: string): string {
  return `<!doctype html><html lang="uk"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light"><title>Вхід на карту</title>
<style>body{font:16px system-ui,sans-serif;background:#0f1115;color:#e8eaed;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
main{max-width:22rem;text-align:center}button{font:inherit;font-weight:600;padding:.8rem 2rem;border:0;border-radius:.6rem;background:#3b82f6;color:#fff;cursor:pointer}
p{color:#9aa0a6}</style></head><body><main><h1>Карта тривог</h1>
<form method="post" action="/auth"><input type="hidden" name="t" value="${escapeAttr(token)}">
<button type="submit">Увійти</button></form><p>Посилання одноразове й діє 10 хвилин.</p></main></body></html>`;
}

export async function buildServer(deps: ServerDeps): Promise<{ app: FastifyInstance; hub: Hub }> {
  const { sql, config } = deps;
  const now = deps.now ?? Date.now;

  const app = Fastify({
    trustProxy: true,
    logger: deps.logger === false ? false : {
      level: config.LOG_LEVEL,
      serializers: {
        req: (req: FastifyRequest) => ({ method: req.method, url: scrubUrl(req.url) }),
      },
    },
  });

  const snapshot = async (): Promise<Snapshot> => {
    // Seq first: an event racing the reads is then replayed, never skipped.
    const seq = await latestSeq(sql);
    const at = now();
    return {
      seq,
      at,
      alerts: await alertsAt(sql, at),
      tracks: await tracksAt(sql, at),
      sources: await sourceStatuses(sql, at, config.SOURCE_STALE_MS),
    };
  };
  const hub = new Hub(sql, snapshot);

  await app.register(compress, { threshold: 1024 });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(websocket, { options: { maxPayload: 4096 } });

  app.decorateRequest('user', null);

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Content-Security-Policy', CSP);
    reply.header('X-Content-Type-Options', 'nosniff');
    // The login link carries a token in its query; no page may leak it onward.
    reply.header('Referrer-Policy', 'no-referrer');
    return payload;
  });

  const setSession = (reply: FastifyReply, id: string) =>
    reply.setCookie(SESSION_COOKIE, id, {
      path: '/',
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: 'lax',
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });

  const authenticate = async (req: FastifyRequest, reply: FastifyReply) => {
    const id = req.cookies[SESSION_COOKIE];
    req.user = id ? await sessionUser(sql, id, now()) : null;
    if (!req.user) return reply.code(401).send({ error: 'unauthorized' });
  };

  // ─── health ───────────────────────────────────────────────────────────────
  app.get('/healthz', async (_req, reply) => {
    try {
      await sql.query('SELECT 1');
      return { ok: true, clients: hub.size };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  // ─── login ────────────────────────────────────────────────────────────────
  /*
   * GET only shows a button; the POST behind it spends the token. Link checkers,
   * chat previews and browser prefetch all issue GETs, and any one of them would
   * otherwise burn a single-use login before the person ever tapped it.
   */
  app.get<{ Querystring: { t?: string } }>('/auth', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const token = typeof req.query.t === 'string' ? req.query.t : '';
    return reply.type('text/html; charset=utf-8').send(confirmPage(token));
  });

  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 2048 },
    (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))),
  );

  app.post<{ Body: { t?: unknown } }>(
    '/auth',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const token = typeof req.body?.t === 'string' ? req.body.t : '';
      const chatId = token ? await consumeLogin(sql, { token }, now()) : null;
      if (chatId === null) return reply.redirect('/?login=expired', 303);
      setSession(reply, await createSession(sql, chatId, now()));
      return reply.redirect('/', 303);
    },
  );

  app.post<{ Body: { code?: unknown } }>(
    '/api/login',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const code = typeof req.body?.code === 'string' ? req.body.code : '';
      if (code.length < 8 || code.length > 20) return reply.code(400).send({ error: 'bad_code' });
      const chatId = await consumeLogin(sql, { code }, now());
      if (chatId === null) return reply.code(401).send({ error: 'invalid_or_expired' });
      setSession(reply, await createSession(sql, chatId, now()));
      return reply.code(204).send();
    },
  );

  app.post('/api/logout', async (req, reply) => {
    const id = req.cookies[SESSION_COOKIE];
    if (id) await deleteSession(sql, id);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  // ─── data ─────────────────────────────────────────────────────────────────
  app.get('/api/me', { preHandler: authenticate }, async (req): Promise<Me> => ({
    name: req.user!.username,
    oblast: req.user!.oblast,
  }));

  app.get('/api/snapshot', { preHandler: authenticate }, async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return snapshot();
  });

  app.get<{ Querystring: { at?: string } }>(
    '/api/history',
    { preHandler: authenticate },
    async (req, reply) => {
      const at = Number(req.query.at);
      const t = now();
      // A little slack past the 3 h window for a slider dragged to its far end.
      if (!Number.isFinite(at) || at > t || at < t - HISTORY_MS - 10 * 60_000) {
        return reply.code(400).send({ error: 'at_out_of_range' });
      }
      const body: Snapshot = {
        seq: 0,
        at,
        alerts: await alertsAt(sql, at),
        tracks: await tracksAt(sql, at),
        sources: [],
      };
      return body;
    },
  );

  const regions = readFileSync(geoDataPath('map-regions.geojson'));
  const regionsEtag = `"${createHash('sha1').update(regions).digest('hex').slice(0, 16)}"`;
  app.get('/api/regions.geojson', { preHandler: authenticate }, async (req, reply) => {
    reply.header('ETag', regionsEtag).header('Cache-Control', 'private, max-age=86400');
    if (req.headers['if-none-match'] === regionsEtag) return reply.code(304).send();
    return reply.type('application/geo+json').send(regions);
  });

  // ─── web push ─────────────────────────────────────────────────────────────
  app.get('/api/push', { preHandler: authenticate }, async (req) => ({
    publicKey: config.VAPID_PUBLIC_KEY ?? null,
    subscriptions: await countPushSubscriptions(sql, req.user!.chatId),
  }));

  const base64url = /^[A-Za-z0-9_-]+=*$/;
  app.post<{ Body: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } }>(
    '/api/push/subscribe',
    { preHandler: authenticate, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!config.VAPID_PUBLIC_KEY) return reply.code(404).send({ error: 'push_not_configured' });
      const { endpoint, keys } = req.body ?? {};
      const p256dh = keys?.p256dh;
      const auth = keys?.auth;
      // A push endpoint is an HTTPS URL of the browser vendor's push service; anything
      // else would turn the worker into a request forwarder.
      let url: URL | null = null;
      try {
        url = typeof endpoint === 'string' && endpoint.length <= 1000 ? new URL(endpoint) : null;
      } catch {
        url = null;
      }
      if (
        !url || url.protocol !== 'https:' || !isPushService(url.hostname) ||
        typeof p256dh !== 'string' || !base64url.test(p256dh) || p256dh.length > 200 ||
        typeof auth !== 'string' || !base64url.test(auth) || auth.length > 100
      ) {
        return reply.code(400).send({ error: 'bad_subscription' });
      }
      await savePushSubscription(sql, req.user!.chatId, { endpoint: url.href, p256dh, auth }, now());
      return reply.code(204).send();
    },
  );

  app.post<{ Body: { endpoint?: unknown } }>(
    '/api/push/unsubscribe',
    { preHandler: authenticate },
    async (req, reply) => {
      const endpoint = req.body?.endpoint;
      if (typeof endpoint === 'string') await deletePushSubscription(sql, req.user!.chatId, endpoint);
      return reply.code(204).send();
    },
  );

  // ─── realtime ─────────────────────────────────────────────────────────────
  app.get('/ws', { websocket: true, preHandler: authenticate }, (socket, req) => {
    const client = hub.add(socket);
    const sessionId = req.cookies[SESSION_COOKIE]!;

    // A logout or an expired session must also end a socket that is already open.
    const recheck = setInterval(async () => {
      if (!(await sessionUser(sql, sessionId, now()).catch(() => null))) socket.close(4401, 'session ended');
    }, 5 * 60_000);
    const ping = setInterval(() => socket.ping(), 25_000);

    socket.on('message', async (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        return;
      }
      if (msg.t === 'ping') socket.send(JSON.stringify({ t: 'pong' }));
      else if (msg.t === 'resume') {
        const seq = typeof msg.seq === 'number' && Number.isFinite(msg.seq) ? msg.seq : null;
        await hub.resume(client, seq).catch((err) => req.log.warn({ err: String(err) }, 'resume failed'));
      }
    });
    socket.on('close', () => {
      clearInterval(recheck);
      clearInterval(ping);
      hub.remove(client);
    });
  });

  // ─── the app ──────────────────────────────────────────────────────────────
  const dist = resolve(config.WEB_DIST);
  if (existsSync(resolve(dist, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: dist,
      wildcard: false,
      // Hashed bundles never change; everything else (index.html, sw.js, the manifest)
      // must be revalidated, or a deploy never reaches an installed app.
      setHeaders: (res, path) => {
        res.header('Cache-Control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== 'GET' || req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found' });
      reply.header('Cache-Control', 'no-cache');
      return reply.sendFile('index.html');
    });
  } else {
    app.log.warn({ dist }, 'web app not built; serving the API only');
  }

  return { app, hub };
}

/**
 * Housekeeping the API owns: pruning its own tables, and turning a channel going
 * quiet (or coming back) into an event, so open maps flag it without polling.
 */
export function startBackground(sql: Sql, staleAfterMs: number, now: () => number = Date.now): () => void {
  let last = new Map<string, boolean>();
  const health = setInterval(async () => {
    try {
      const statuses = await sourceStatuses(sql, now(), staleAfterMs);
      const next = new Map(statuses.map((s) => [s.source, s.healthy]));
      for (const s of statuses) {
        if (last.size > 0 && last.get(s.source) !== s.healthy) {
          await sql.transaction((tx) => appendEvent(tx, { type: 'source.status', source: s }, now()));
        }
      }
      last = next;
    } catch {
      // The next tick retries; a database blip must not kill the process.
    }
  }, 30_000);

  const prune = setInterval(async () => {
    await pruneEvents(sql, undefined, now()).catch(() => {});
    await pruneAuth(sql, now()).catch(() => {});
  }, 60 * 60_000);

  health.unref();
  prune.unref();
  return () => {
    clearInterval(health);
    clearInterval(prune);
  };
}
