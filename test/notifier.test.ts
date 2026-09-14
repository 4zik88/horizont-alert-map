import assert from 'node:assert/strict';
import { test, describe, beforeEach } from 'node:test';
import { AppState, Users } from '../src/db/users.js';
import { Notifier, DEFAULT_NOTIFIER } from '../src/notify/notifier.js';
import type { TelegramApi } from '../src/bot/api.js';
import { escapeHtml, formatAlertBatch, type AlertLine } from '../src/bot/format.js';
import { memoryDb } from './helpers.js';

const NOW = 1_700_000_000_000;
const OKHTYRKA = { lat: 50.31, lon: 34.89 };

/** Captures what would have been sent instead of hitting Telegram. */
function fakeApi() {
  const sent: { chatId: number; text: string }[] = [];
  let fail = false;
  const api = {
    async sendMessage(chatId: number, text: string) {
      if (fail) throw new Error('blocked by user');
      sent.push({ chatId, text });
    },
  } as unknown as TelegramApi;
  return { api, sent, setFail: (v: boolean) => { fail = v; } };
}

function setup() {
  const db = memoryDb();
  const users = new Users(db);
  const state = new AppState(db);
  const { api, sent, setFail } = fakeApi();
  const notifier = new Notifier(db, users, state, api, DEFAULT_NOTIFIER);
  return { db, users, state, notifier, sent, setFail };
}

function addUser(users: Users, chatId: number, lat: number, lon: number, radiusKm = 40) {
  users.register(chatId, `u${chatId}`, NOW);
  users.saveLocation({ chatId, lat, lon, kind: 'static', oblast: 'sumska', liveUntil: null, now: NOW });
  users.updateRadius(chatId, radiusKm, NOW);
}

let seq = 0;
function addTarget(db: ReturnType<typeof memoryDb>, over: Record<string, unknown> = {}) {
  db.prepare(`INSERT INTO messages (channel, message_id, posted_at, fetched_at, text, content_hash)
              VALUES ('t', ?, ?, ?, 'x', ?)`).run(++seq, NOW, NOW, `h${seq}`);
  const messageId = db.prepare('SELECT id FROM messages WHERE message_id = ?').get(seq) as { id: number };
  const row = {
    type: 'uav', count: 1, to_name: 'Охтирка', to_lat: OKHTYRKA.lat, to_lon: OKHTYRKA.lon,
    from_lat: null, from_lon: null, course_deg: null, confidence: 0.95, observed_at: NOW - 60_000,
    ...over,
  };
  db.prepare(`INSERT INTO targets
      (message_id, seq, type, count, oblast, relation, to_name, to_lat, to_lon,
       from_lat, from_lon, course_deg, confidence, source, observed_at, created_at)
     VALUES (@mid, 0, @type, @count, 'sumska', 'towards', @to_name, @to_lat, @to_lon,
       @from_lat, @from_lon, @course_deg, @confidence, 'rules', @observed_at, @now)`)
    .run({ ...row, mid: messageId.id, now: NOW });
}

describe('Notifier', () => {
  beforeEach(() => { seq = 0; });

  test('warns a user whose radius covers the target', async () => {
    const { db, users, notifier, sent } = setup();
    addUser(users, 100, 50.31, 34.6);
    addTarget(db);

    const result = await notifier.runOnce(NOW);

    assert.equal(result.sent, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.text, /БпЛА/);
    assert.match(sent[0]!.text, /Охтирка/);
    assert.match(sent[0]!.text, /км від вас/);
  });

  test('leaves a distant user alone', async () => {
    const { db, users, notifier, sent } = setup();
    addUser(users, 100, 46.48, 30.72, 40); // Odesa
    addTarget(db);

    await notifier.runOnce(NOW);
    assert.equal(sent.length, 0);
  });

  test('does not notify a user who sent /stop', async () => {
    const { db, users, notifier, sent } = setup();
    addUser(users, 100, 50.31, 34.6);
    users.setStopped(100, NOW);
    addTarget(db);

    await notifier.runOnce(NOW);
    assert.equal(sent.length, 0);
  });

  test('does not notify a user with no location', async () => {
    const { db, users, notifier, sent } = setup();
    users.register(100, 'u', NOW);
    addTarget(db);

    await notifier.runOnce(NOW);
    assert.equal(sent.length, 0);
  });

  // The spec's rule: at most one message about a given target per user per 5 minutes.
  test('does not repeat the same target inside the cooldown', async () => {
    const { db, users, state, notifier, sent } = setup();
    addUser(users, 100, 50.31, 34.6);
    addTarget(db);

    await notifier.runOnce(NOW);
    assert.equal(sent.length, 1);

    // Rewind the cursor so the same target is scanned again.
    state.setNumber('notify_target_cursor', 0, NOW);
    await notifier.runOnce(NOW + 60_000);
    assert.equal(sent.length, 1, 'still just the one message');

    state.setNumber('notify_target_cursor', 0, NOW);
    await notifier.runOnce(NOW + 6 * 60_000);
    assert.equal(sent.length, 2, 'allowed again once the cooldown has passed');
  });

  // A mass attack can match one user against many targets at once. Separate messages
  // for each is how an alerting bot gets muted.
  test('combines several targets into one message', async () => {
    const { db, users, notifier, sent } = setup();
    addUser(users, 100, 50.31, 34.6);
    addTarget(db, { to_name: 'Охтирка' });
    addTarget(db, { to_name: 'Тростянець', to_lat: 50.48, to_lon: 34.96 });
    addTarget(db, { to_name: 'Лебедин', to_lat: 50.58, to_lon: 34.49 });

    const result = await notifier.runOnce(NOW);

    assert.equal(sent.length, 1, 'one message, not three');
    assert.equal(result.sent, 3);
    assert.equal(sent[0]!.text.split('\n').length, 3);
  });

  test('advances its cursor so a restart does not re-warn', async () => {
    const { db, users, notifier, sent } = setup();
    addUser(users, 100, 50.31, 34.6);
    addTarget(db);

    await notifier.runOnce(NOW);
    await notifier.runOnce(NOW + 1000);
    assert.equal(sent.length, 1);
  });

  // A failed send must be retried, not silently swallowed by the cooldown.
  test('does not record a notification that failed to send', async () => {
    const { db, users, state, notifier, sent, setFail } = setup();
    addUser(users, 100, 50.31, 34.6);
    addTarget(db);

    setFail(true);
    await notifier.runOnce(NOW);
    assert.equal(sent.length, 0);

    setFail(false);
    state.setNumber('notify_target_cursor', 0, NOW);
    await notifier.runOnce(NOW + 1000);
    assert.equal(sent.length, 1, 'retried after the failure');
  });

  test('warns several users independently', async () => {
    const { db, users, notifier, sent } = setup();
    addUser(users, 100, 50.31, 34.6);
    addUser(users, 200, 50.35, 34.8);
    addUser(users, 300, 46.48, 30.72); // far away
    addTarget(db);

    await notifier.runOnce(NOW);
    assert.deepEqual(sent.map((s) => s.chatId).sort(), [100, 200]);
  });
});

describe('formatAlertBatch', () => {
  const line = (over: Partial<AlertLine> = {}): AlertLine => ({
    type: 'uav', count: 1, toName: 'Охтирка', distanceKm: 20, reason: 'in_radius', ...over,
  });

  test('formats a single alert exactly as the spec asks', () => {
    assert.equal(
      formatAlertBatch([line({ reason: 'heading_towards', distanceKm: 23.4 })]),
      '⚠️ БпЛА, курс на Охтирка, ~23 км від вас',
    );
  });

  // Three channels reporting one drone must not read as three drones.
  test('collapses duplicate reports of the same target', () => {
    const text = formatAlertBatch([
      line({ distanceKm: 25 }),
      line({ distanceKm: 20 }),
      line({ distanceKm: 30 }),
    ]);
    assert.equal(text.split('\n').length, 1);
    assert.match(text, /~20 км/, 'keeps the nearest reading');
  });

  test('keeps genuinely different targets apart', () => {
    const text = formatAlertBatch([
      line({ toName: 'Охтирка' }),
      line({ toName: 'Тростянець', distanceKm: 35 }),
      line({ toName: 'Охтирка', type: 'cruise', distanceKm: 22 }),
    ]);
    assert.equal(text.split('\n').length, 3);
  });

  test('orders by distance, nearest first', () => {
    const text = formatAlertBatch([
      line({ toName: 'Далеке', distanceKm: 80 }),
      line({ toName: 'Близьке', distanceKm: 5 }),
    ]);
    assert.match(text.split('\n')[0]!, /Близьке/);
  });

  test('keeps the largest reported count', () => {
    const text = formatAlertBatch([line({ count: 1 }), line({ count: 3, distanceKm: 25 })]);
    assert.match(text, /×3/);
  });
});

describe('formatAlertLine — HTML safety', () => {
  /*
   * Every send uses parse_mode HTML, and Telegram rejects the whole message with 400
   * if the markup does not parse. An unescaped name would therefore drop the entire
   * warning for that user, not just the line naming the place.
   */
  test('escapes a place name so one bad character cannot drop the warning', () => {
    const line: AlertLine = {
      type: 'uav',
      count: 1,
      toName: 'Ново<b>Село & Co',
      distanceKm: 12,
      reason: 'in_radius',
    };
    const text = formatAlertBatch([line]);
    assert.ok(!/<b>/.test(text), 'raw tag survived into the message');
    assert.match(text, /Ново&lt;b&gt;Село &amp; Co/);
  });

  test('leaves ordinary names untouched', () => {
    assert.equal(escapeHtml("Кам'янець-Подільський"), "Кам'янець-Подільський");
  });
});
