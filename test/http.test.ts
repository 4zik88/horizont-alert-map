import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import type { Server } from 'node:http';
import { memoryDb } from './helpers.js';

/*
 * The token is read once, when `src/config.ts` is first imported — so it has to be in
 * the environment before the server module is loaded, not before the server is
 * started. Hence the dynamic imports below: a static one would be hoisted above this
 * assignment and every route would answer 404 for want of a configured token.
 */
process.env['MAP_TOKEN'] = 'test-token-abcdef123456';

/*
 * The HTTP surface had no coverage at all, and it broke twice in a row in ways that
 * looked identical from the outside: a flat "Not found" on a phone, with nothing in
 * the logs and a healthy service. Both were in this handful of routes — first the
 * manifest, fetched without credentials and so 404, then the token link itself, which
 * only ever set a cookie and left the cookie as the single way back in.
 *
 * What these assert is the contract that failure violated: the secret link works on
 * its own, in a cold browser that has never seen a cookie.
 */

const TOKEN = process.env['MAP_TOKEN']!;

let server: Server;
let base: string;

before(async () => {
  const { Repo } = await import('../src/db/repo.js');
  const { startServer } = await import('../src/http/server.js');

  const repo = new Repo(memoryDb());
  server = startServer(repo, undefined, {
    port: 0,
    pollIntervalMs: 20_000,
    publicDir: 'public',
  });
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

after(() => server.close());

/** A fetch that never follows redirects and never carries a cookie. */
const cold = (path: string, headers: Record<string, string> = {}) =>
  fetch(base + path, { redirect: 'manual', headers });

describe('http auth', () => {
  test('the token link serves the map itself, not a redirect to it', async () => {
    const res = await cold(`/t/${TOKEN}`);

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await res.text(), /<title>Horizont<\/title>/);
  });

  test('the token link also sets the session cookie', async () => {
    const res = await cold(`/t/${TOKEN}`);
    const cookie = res.headers.get('set-cookie') ?? '';

    assert.match(cookie, /^hz=[0-9a-f]{64};/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    // The token itself must never be the cookie: the cookie is readable by anyone
    // who can see the request, and it would put the secret back in a second place.
    assert.ok(!cookie.includes(TOKEN));
  });

  test('a cold browser reaches every asset the page needs', async () => {
    const granted = await cold(`/t/${TOKEN}`);
    const cookie = (granted.headers.get('set-cookie') ?? '').split(';')[0]!;

    for (const path of ['/app.js', '/style.css', '/config.js', '/manifest.webmanifest']) {
      const res = await cold(path, { cookie });
      assert.equal(res.status, 200, `${path} should be served with the session cookie`);
    }
  });

  test('the manifest points the installed app back at the token, not at /', async () => {
    const granted = await cold(`/t/${TOKEN}`);
    const cookie = (granted.headers.get('set-cookie') ?? '').split(';')[0]!;

    const manifest = (await (await cold('/manifest.webmanifest', { cookie })).json()) as
      { start_url: string; scope: string };
    // A home-screen app gets its own cookie jar on iOS. A start_url of "/" launches
    // into that empty jar and gets the same 404 a stranger gets.
    assert.equal(manifest.start_url, `/t/${TOKEN}`);
    assert.equal(manifest.scope, '/');
  });

  test('a wrong token is 404, never 403', async () => {
    const res = await cold('/t/wrong-token-000000000');

    assert.equal(res.status, 404);
    assert.equal(await res.text(), 'Not found\n');
  });

  test('the map is 404 without a cookie', async () => {
    for (const path of ['/', '/app.js', '/manifest.webmanifest', '/api/state']) {
      assert.equal((await cold(path)).status, 404, `${path} must be closed`);
    }
  });

  test('health and robots stay open, and robots forbids everything', async () => {
    assert.equal((await cold('/healthz')).status, 503); // no channels polled yet
    const robots = await cold('/robots.txt');
    assert.equal(robots.status, 200);
    assert.match(await robots.text(), /Disallow: \/$/m);
  });

  test('no response leaks the path in a Referer', async () => {
    const granted = await cold(`/t/${TOKEN}`);
    // strict-origin sends the origin only, so the token in the address bar never
    // travels to a tile server.
    assert.equal(granted.headers.get('referrer-policy'), 'strict-origin');
  });

  test('path traversal cannot escape the public directory', async () => {
    const granted = await cold(`/t/${TOKEN}`);
    const cookie = (granted.headers.get('set-cookie') ?? '').split(';')[0]!;

    for (const path of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/package.json']) {
      assert.equal((await cold(path, { cookie })).status, 404, `${path} must not resolve`);
    }
  });
});
