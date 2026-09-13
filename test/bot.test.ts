import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { Gazetteer } from '../src/parser/gazetteer.js';
import { memoryDb, seedGazetteer } from './helpers.js';

process.env['ALLOWED_CHAT_IDS'] = '100';
const { Bot } = await import('../src/bot/bot.js');
const { AppState, Users } = await import('../src/db/users.js');
import type { TelegramApi, TelegramUpdate } from '../src/bot/api.js';

const NOW = 1_700_000_000_000;

function setup() {
  const db = memoryDb();
  seedGazetteer(db, [
    { name: 'Охтирка', oblast: 'sumska', place: 'town', population: 47000, lat: 50.31, lon: 34.89 },
    { name: 'Одеса', oblast: 'odeska', place: 'city', population: 1010000, lat: 46.48, lon: 30.72 },
  ]);
  const users = new Users(db);
  const state = new AppState(db);
  const sent: { chatId: number; text: string }[] = [];
  const api = {
    async sendMessage(chatId: number, text: string) { sent.push({ chatId, text }); },
  } as unknown as TelegramApi;

  const bot = new Bot(api, users, state, new Gazetteer(db), { pollTimeoutSeconds: 1 });
  // handle() is private; tests drive it as the poll loop would.
  const feed = (u: TelegramUpdate) => (bot as unknown as {
    handle(u: TelegramUpdate): Promise<void>;
  }).handle(u);

  return { db, users, state, sent, feed };
}

let updateId = 0;
const text = (chatId: number, body: string): TelegramUpdate => ({
  update_id: ++updateId,
  message: { message_id: updateId, date: NOW / 1000, chat: { id: chatId, type: 'private' }, text: body },
});
const location = (chatId: number, lat: number, lon: number, livePeriod?: number): TelegramUpdate => ({
  update_id: ++updateId,
  message: {
    message_id: updateId, date: NOW / 1000, chat: { id: chatId, type: 'private' },
    location: { latitude: lat, longitude: lon, ...(livePeriod ? { live_period: livePeriod } : {}) },
  },
});

describe('Bot access', () => {
  // A stranger gets no reply at all — not even a refusal, which would confirm the
  // bot exists to someone probing.
  test('ignores anyone not on the allowlist, silently', async () => {
    const { sent, feed, users } = setup();
    await feed(text(999, '/start'));
    assert.equal(sent.length, 0);
    assert.equal(users.get(999), undefined, 'and stores nothing about them');
  });

  test('answers an allowed chat', async () => {
    const { sent, feed } = setup();
    await feed(text(100, '/start'));
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.text, /Horizont/);
  });
});

describe('Bot commands', () => {
  test('/start registers the user', async () => {
    const { users, feed } = setup();
    await feed(text(100, '/start'));
    const user = users.get(100);
    assert.equal(user?.chat_id, 100);
    assert.equal(user?.radius_km, 40, 'default radius from the spec');
    assert.equal(user?.is_active, 1);
  });

  test('a location is stored with its oblast resolved', async () => {
    const { users, feed, sent } = setup();
    await feed(location(100, 50.31, 34.6));
    const user = users.get(100);
    assert.equal(user?.lat, 50.31);
    assert.equal(user?.location_kind, 'static');
    assert.equal(user?.oblast, 'sumska', 'resolved from the nearest settlement');
    assert.match(sent.at(-1)!.text, /Локация сохранена/);
  });

  // Coordinates must not be echoed back: they would then sit in Telegram history
  // and in any screenshot of the chat.
  test('never echoes the coordinates back', async () => {
    const { feed, sent } = setup();
    await feed(location(100, 50.3105, 34.6012));
    assert.doesNotMatch(sent.at(-1)!.text, /50\.31|34\.60/);
  });

  test('a live location is marked live and given an expiry', async () => {
    const { users, feed, sent } = setup();
    await feed(location(100, 50.31, 34.6, 3600));
    const user = users.get(100);
    assert.equal(user?.location_kind, 'live');
    assert.ok((user?.live_until ?? 0) > Date.now());
    assert.match(sent.at(-1)!.text, /Live/);
  });

  // Live location moves arrive as edits, not new messages; ignoring them means a
  // live location never actually updates.
  test('an edited message updates the stored position', async () => {
    const { users, feed } = setup();
    await feed(location(100, 50.31, 34.6, 3600));

    await feed({
      update_id: ++updateId,
      edited_message: {
        message_id: 1, date: NOW / 1000, chat: { id: 100, type: 'private' },
        location: { latitude: 46.48, longitude: 30.72, live_period: 3600 },
      },
    });

    const user = users.get(100);
    assert.equal(user?.lat, 46.48);
    assert.equal(user?.oblast, 'odeska', 'oblast follows the user');
  });

  test('a location before /start still registers the user', async () => {
    const { users, feed } = setup();
    await feed(location(100, 50.31, 34.6));
    assert.equal(users.get(100)?.radius_km, 40);
  });

  test('/radius sets the radius', async () => {
    const { users, feed, sent } = setup();
    await feed(text(100, '/start'));
    await feed(text(100, '/radius 25'));
    assert.equal(users.get(100)?.radius_km, 25);
    assert.match(sent.at(-1)!.text, /25 км/);
  });

  test('/radius rejects values outside the sane range', async () => {
    const { users, feed, sent } = setup();
    await feed(text(100, '/start'));
    await feed(text(100, '/radius 5000'));
    assert.equal(users.get(100)?.radius_km, 40, 'unchanged');
    assert.match(sent.at(-1)!.text, /от 5 до 200/);
  });

  test('/radius with no number reports the current value', async () => {
    const { feed, sent } = setup();
    await feed(text(100, '/start'));
    await feed(text(100, '/radius'));
    assert.match(sent.at(-1)!.text, /Текущий радиус: 40 км/);
  });

  test('/stop deactivates but keeps the settings', async () => {
    const { users, feed } = setup();
    await feed(text(100, '/start'));
    await feed(text(100, '/radius 25'));
    await feed(text(100, '/stop'));

    const user = users.get(100);
    assert.equal(user?.is_active, 0);
    assert.equal(user?.radius_km, 25, 'settings survive a /stop');
  });

  test('/start after /stop re-activates without losing settings', async () => {
    const { users, feed } = setup();
    await feed(text(100, '/start'));
    await feed(text(100, '/radius 25'));
    await feed(text(100, '/stop'));
    await feed(text(100, '/start'));

    const user = users.get(100);
    assert.equal(user?.is_active, 1);
    assert.equal(user?.radius_km, 25);
  });

  test('/status reports the current state', async () => {
    const { feed, sent } = setup();
    await feed(text(100, '/start'));
    await feed(location(100, 50.31, 34.6));
    await feed(text(100, '/status'));
    assert.match(sent.at(-1)!.text, /включены/);
    assert.match(sent.at(-1)!.text, /40 км/);
  });

  test('handles a command addressed to the bot by name', async () => {
    const { users, feed } = setup();
    await feed(text(100, '/radius@horizont_bot 30'));
    assert.equal(users.get(100)?.radius_km ?? 40, 40, 'user not registered yet, so unchanged');
    await feed(text(100, '/start'));
    await feed(text(100, '/radius@horizont_bot 30'));
    assert.equal(users.get(100)?.radius_km, 30);
  });

  test('unknown input gets the help text', async () => {
    const { feed, sent } = setup();
    await feed(text(100, 'привет'));
    assert.match(sent.at(-1)!.text, /Команды/);
  });
});
