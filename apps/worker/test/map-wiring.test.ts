import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { consumeLogin, eventsAfter } from '@horizont/db';
import { seedGazetteer, useTestDb } from './helpers.js';
import type { TelegramApi, TelegramUpdate } from '../src/bot/api.js';

// Config is read once, on first import; the allowlist must be in place before that.
process.env['ALLOWED_CHAT_IDS'] = '100';
const { Bot } = await import('../src/bot/bot.js');
const { AppState, Users } = await import('../src/db/users.js');
const { loadGazetteer } = await import('../src/db/gazetteer.js');
const { Repo } = await import('../src/db/repo.js');
const { DISABLED_EXTRACTOR } = await import('../src/parser/llm.js');
const { ParseWorker } = await import('../src/parser/worker.js');
const { mapPublisher, publishAlerts } = await import('../src/map/publish.js');
const { mapLoginMessage } = await import('../src/map/login.js');

const getDb = useTestDb();

async function parseWorker() {
  const db = getDb();
  await seedGazetteer(db, [
    { name: 'Охтирка', oblast: 'sumska', place: 'town', population: 47000, lat: 50.31, lon: 34.89 },
    { name: 'Ніжин', oblast: 'chernihivska', place: 'city', population: 70000, lat: 51.05, lon: 31.88 },
  ]);
  const worker = new ParseWorker(await loadGazetteer(db), new Repo(db), DISABLED_EXTRACTOR, {
    batchSize: 50, intervalMs: 60_000, llmBudgetPerBatch: 0, publisher: mapPublisher(db),
  });
  return { db, worker };
}

describe('parsed targets reach the map', () => {
  test('a report becomes a track and an event', async () => {
    const { db, worker } = await parseWorker();
    await db.query(
      `INSERT INTO messages (channel, message_id, posted_at, fetched_at, text, content_hash)
       VALUES ('kpszsu', 1, $1, $1, 'Сумщина:\nБпЛА над Охтиркою', 'a')`,
      [Date.now()],
    );
    await worker.runBatch();
    const tracks = await db.query('SELECT * FROM target_tracks');
    assert.equal(tracks.rows.length, 1);
    assert.deepEqual((await eventsAfter(db, 0)).map((e) => e.e.type), ['track.observed']);
  });

  test('an edit that moves the target retracts the old track', async () => {
    const { db, worker } = await parseWorker();
    await db.query(
      `INSERT INTO messages (channel, message_id, posted_at, fetched_at, text, content_hash)
       VALUES ('kpszsu', 1, $1, $1, 'Сумщина:\nБпЛА над Охтиркою', 'a')`,
      [Date.now()],
    );
    await worker.runBatch();
    await db.query(
      `UPDATE messages SET text = 'Чернігівщина:\nБпЛА над Ніжином', content_hash = 'b', parse_state = 'pending'`,
    );
    await worker.runBatch();

    const types = (await eventsAfter(db, 0)).map((e) => e.e.type);
    assert.deepEqual(types, ['track.observed', 'track.observed', 'track.revised']);
    const tracks = await db.query<{ last_lat: number }>('SELECT last_lat FROM target_tracks');
    assert.deepEqual(tracks.rows.map((r) => r.last_lat), [51.05]);
  });
});

describe('alert polls reach the map', () => {
  test('an accepted poll opens intervals; the next identical one changes nothing', async () => {
    const db = getDb();
    const state = { levels: new Map([['sumska', 'full' as const]]), areas: new Map(), threats: [] };
    await publishAlerts(db, state, 1000);
    await publishAlerts(db, state, 2000);
    const { rows } = await db.query<{ region_id: string; ended_at: number | null }>('SELECT region_id, ended_at FROM alerts');
    assert.deepEqual(rows, [{ region_id: 'oblast:sumska', ended_at: null }]);
  });
});

describe('map login from the bot', () => {
  async function bot(withMap: boolean) {
    const db = getDb();
    const users = new Users(db);
    const sent: string[] = [];
    const api = { async sendMessage(_c: number, text: string) { sent.push(text); } } as unknown as TelegramApi;
    const b = new Bot(api, users, new AppState(db), await loadGazetteer(db), {
      pollTimeoutSeconds: 1,
      ...(withMap ? { mapLogin: mapLoginMessage(db, 'https://map.example/') } : {}),
    });
    let id = 0;
    const say = (body: string) => (b as unknown as { handle(u: TelegramUpdate): Promise<void> }).handle({
      update_id: ++id,
      message: { message_id: id, date: 0, chat: { id: 100, type: 'private' }, text: body },
    });
    return { db, users, sent, say };
  }

  test('/map sends a working link and code, and does not switch warnings back on', async () => {
    const { db, users, sent, say } = await bot(true);
    await say('/start');
    await say('/stop');
    sent.length = 0;
    await say('/map');

    assert.equal((await users.get(100))?.is_active, 0, '/stop still holds');
    const msg = sent[0]!;
    const token = decodeURIComponent(/\/auth\?t=([^"&]+)/.exec(msg)![1]!);
    assert.match(msg, /^🗺/);
    assert.match(msg, /href="https:\/\/map\.example\/auth\?t=/);
    assert.match(msg, /<code>[A-Z2-9]{4}-[A-Z2-9]{4}<\/code>/);
    assert.equal(await consumeLogin(db, { token }), 100);
  });

  test('/start also sends the login; without PUBLIC_URL /map says so', async () => {
    const a = await bot(true);
    await a.say('/start');
    assert.equal(a.sent.length, 2);

    const b = await bot(false);
    await b.say('/map');
    assert.deepEqual(b.sent, ['Карту ще не налаштовано.']);
  });
});
