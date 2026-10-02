import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { ServerMessage } from '@horizont/contract';
import { appendEvent, createSession, issueLogin, syncAlerts, type Sql } from '@horizont/db';
import { testDb, truncateAll } from '@horizont/db/testing';
import type { FastifyInstance } from 'fastify';
import { buildServer, SESSION_COOKIE } from '../src/server.js';
import type { Hub } from '../src/hub.js';

const NOW = Date.UTC(2026, 9, 2, 20, 0);
const config = { cookieSecure: true, WEB_DIST: '/nonexistent', SOURCE_STALE_MS: 100_000, LOG_LEVEL: 'error' as const, NODE_ENV: 'test' as const };

let sql: Sql;
let app: FastifyInstance;
let hub: Hub;

before(async () => {
  sql = await testDb();
  ({ app, hub } = await buildServer({ sql, config, now: () => NOW, logger: false }));
  await app.ready();
});
after(async () => {
  await hub.stop();
  await app.close();
  await sql.close();
});
beforeEach(async () => {
  await truncateAll(sql);
  await sql.query(
    `INSERT INTO users (chat_id, username, oblast, is_active, created_at, updated_at) VALUES (42, 'me', 'sumska', 1, 0, 0)`,
  );
});

const followLink = (token: string) =>
  app.inject({ method: 'POST', url: '/auth', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `t=${encodeURIComponent(token)}` });

/**
 * A session for tests that are not about logging in. Going through POST /auth every
 * time trips its 10-per-minute rate limit, which is that limit doing its job.
 */
async function login(): Promise<string> {
  return `${SESSION_COOKIE}=${await createSession(sql, 42, NOW)}`;
}

describe('access', () => {
  test('everything but login is closed without a session', async () => {
    for (const url of ['/api/me', '/api/snapshot', `/api/history?at=${NOW}`, '/api/regions.geojson']) {
      assert.equal((await app.inject({ url })).statusCode, 401, url);
    }
  });

  test('opening the link only shows a button; it does not spend the login', async () => {
    const { token } = await issueLogin(sql, 42, NOW);
    for (let i = 0; i < 3; i++) {
      const page = await app.inject({ url: `/auth?t=${token}` });
      assert.equal(page.statusCode, 200);
      assert.match(page.body, /<form method="post" action="\/auth">/);
      assert.equal(page.cookies.length, 0);
    }
    assert.equal((await followLink(token)).headers.location, '/', 'still valid after three previews');
  });

  test('the button sets a hardened cookie, redirects home, and works once', async () => {
    const { token } = await issueLogin(sql, 42, NOW);
    const res = await followLink(token);
    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, '/');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.equal(res.headers['cache-control'], 'no-store');
    const c = res.cookies.find((x) => x.name === SESSION_COOKIE)!;
    assert.equal(c.httpOnly, true);
    assert.equal(c.secure, true);
    assert.equal(c.sameSite, 'Lax');

    const again = await followLink(token);
    assert.equal(again.headers.location, '/?login=expired');
  });

  test('the token cannot break out of the confirm page', async () => {
    const page = await app.inject({ url: `/auth?t=${encodeURIComponent('"><script>x</script>')}` });
    assert.ok(!page.body.includes('<script>'));
  });

  test('the typed code logs in; a wrong one does not', async () => {
    const { code } = await issueLogin(sql, 42, NOW);
    assert.equal((await app.inject({ method: 'POST', url: '/api/login', payload: { code: 'AAAA-BBBB' } })).statusCode, 401);
    const ok = await app.inject({ method: 'POST', url: '/api/login', payload: { code: code.toLowerCase() } });
    assert.equal(ok.statusCode, 204);
    assert.ok(ok.cookies.some((c) => c.name === SESSION_COOKIE));
  });

  test('me never carries coordinates', async () => {
    await sql.query('UPDATE users SET lat = 50.9, lon = 34.8 WHERE chat_id = 42');
    const res = await app.inject({ url: '/api/me', headers: { cookie: await login() } });
    assert.deepEqual(res.json(), { name: 'me', oblast: 'sumska' });
  });

  test('logout ends the session', async () => {
    const cookie = await login();
    assert.equal((await app.inject({ method: 'POST', url: '/api/logout', headers: { cookie } })).statusCode, 204);
    assert.equal((await app.inject({ url: '/api/me', headers: { cookie } })).statusCode, 401);
  });

  test('every response carries the CSP', async () => {
    const res = await app.inject({ url: '/healthz' });
    assert.match(String(res.headers['content-security-policy']), /default-src 'self'/);
  });
});

describe('data', () => {
  test('snapshot holds open alerts and the current seq', async () => {
    await syncAlerts(sql, [{ regionId: 'raion:sumska:сумський', oblast: 'sumska', level: 'raion', severity: 'full', areas: [] }], NOW - 60_000);
    const res = await app.inject({ url: '/api/snapshot', headers: { cookie: await login() } });
    const snap = res.json();
    assert.equal(snap.alerts.length, 1);
    assert.equal(snap.seq, 1);
    assert.deepEqual(snap.tracks, []);
  });

  test('history refuses a moment outside the last three hours', async () => {
    const cookie = await login();
    assert.equal((await app.inject({ url: `/api/history?at=${NOW + 1000}`, headers: { cookie } })).statusCode, 400);
    assert.equal((await app.inject({ url: `/api/history?at=${NOW - 4 * 3_600_000}`, headers: { cookie } })).statusCode, 400);
    assert.equal((await app.inject({ url: `/api/history?at=${NOW - 3_600_000}`, headers: { cookie } })).statusCode, 200);
  });

  test('regions are served with an ETag and revalidate to 304', async () => {
    const cookie = await login();
    const res = await app.inject({ url: '/api/regions.geojson', headers: { cookie } });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().features.length > 150);
    const etag = String(res.headers.etag);
    assert.equal((await app.inject({ url: '/api/regions.geojson', headers: { cookie, 'if-none-match': etag } })).statusCode, 304);
  });
});

describe('websocket', () => {
  async function socket(cookie: string) {
    const ws = await app.injectWS('/ws', { headers: { cookie } });
    const inbox: ServerMessage[] = [];
    ws.on('message', (d) => inbox.push(JSON.parse(String(d))));
    const next = async (n: number) => {
      for (let i = 0; i < 100 && inbox.length < n; i++) await new Promise((r) => setTimeout(r, 10));
      return inbox;
    };
    return { ws, next };
  }

  test('rejects an unauthenticated upgrade', async () => {
    await assert.rejects(app.injectWS('/ws'));
  });

  test('resume without a seq gets a snapshot, then live events in order', async () => {
    await hub.start(50);
    const { ws, next } = await socket(await login());
    ws.send(JSON.stringify({ t: 'resume', seq: null }));
    assert.equal((await next(1))[0]!.t, 'snapshot');

    await sql.transaction((tx) => appendEvent(tx, { type: 'alert.ended', alertId: 1, endedAt: NOW }, NOW));
    await sql.transaction((tx) => appendEvent(tx, { type: 'alert.ended', alertId: 2, endedAt: NOW }, NOW));
    const inbox = await next(3);
    assert.deepEqual(inbox.slice(1).map((m) => (m.t === 'event' ? m.seq : -1)), [1, 2]);
    ws.terminate();
    await hub.stop();
  });

  test('resume from a known seq replays only what was missed', async () => {
    for (let i = 1; i <= 3; i++) {
      await sql.transaction((tx) => appendEvent(tx, { type: 'alert.ended', alertId: i, endedAt: NOW }, NOW));
    }
    await hub.start(50);
    const { ws, next } = await socket(await login());
    ws.send(JSON.stringify({ t: 'resume', seq: 1 }));
    const inbox = await next(2);
    assert.deepEqual(inbox.map((m) => m.t === 'event' && m.seq), [2, 3]);
    ws.send(JSON.stringify({ t: 'ping' }));
    assert.equal((await next(3))[2]!.t, 'pong');
    ws.terminate();
    await hub.stop();
  });
});

describe('web push subscriptions', () => {
  const sub = (endpoint: string) => ({ endpoint, keys: { p256dh: 'BOr1x4G3yU2qM9_s', auth: 'k8JV6sjdbhAi' } });

  test('without a VAPID key the server says push is off and refuses subscriptions', async () => {
    const cookie = await login();
    assert.deepEqual((await app.inject({ url: '/api/push', headers: { cookie } })).json(), { publicKey: null, subscriptions: 0 });
    const res = await app.inject({ method: 'POST', url: '/api/push/subscribe', headers: { cookie }, payload: sub('https://fcm.googleapis.com/fcm/send/abc') });
    assert.equal(res.statusCode, 404);
  });

  test('with a key: stores a real push endpoint, refuses anything else, and unsubscribes', async () => {
    const keyed = await buildServer({ sql, config: { ...config, VAPID_PUBLIC_KEY: 'B'.repeat(87) }, now: () => NOW, logger: false });
    await keyed.app.ready();
    const cookie = await login();
    const post = (body: unknown) => keyed.app.inject({ method: 'POST', url: '/api/push/subscribe', headers: { cookie }, payload: body as object });

    assert.equal((await post(sub('https://fcm.googleapis.com/fcm/send/abc'))).statusCode, 204);
    assert.equal((await post(sub('https://web.push.apple.com/QH0'))).statusCode, 204);
    for (const bad of ['http://fcm.googleapis.com/x', 'https://evil.example/x', 'https://worker.railway.internal/x', 'https://fcm.googleapis.com.evil.example/x']) {
      assert.equal((await post(sub(bad))).statusCode, 400, bad);
    }
    assert.equal((await post({ endpoint: 'https://fcm.googleapis.com/fcm/send/z', keys: { p256dh: '<script>', auth: 'x' } })).statusCode, 400);

    const info = (await keyed.app.inject({ url: '/api/push', headers: { cookie } })).json();
    assert.equal(info.subscriptions, 2);
    assert.equal(info.publicKey.length, 87);

    await keyed.app.inject({ method: 'POST', url: '/api/push/unsubscribe', headers: { cookie }, payload: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc' } });
    assert.equal((await keyed.app.inject({ url: '/api/push', headers: { cookie } })).json().subscriptions, 1);
    await keyed.hub.stop();
    await keyed.app.close();
  });

  test('subscribing requires a session', async () => {
    assert.equal((await app.inject({ method: 'POST', url: '/api/push/subscribe', payload: sub('https://fcm.googleapis.com/x') })).statusCode, 401);
  });
});
