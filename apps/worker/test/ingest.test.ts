import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { ingestMessages } from '../src/telegram/ingest.js';
import { parsePage } from '@horizont/parser';
import { isSensitive } from '@horizont/parser';
import { Repo } from '../src/db/repo.js';
import type { Db } from '../src/db/index.js';
import { fixture, useTestDb } from './helpers.js';

const page = () => parsePage(fixture('sectorv666.html'), 'sectorv666');

const getDb = useTestDb();
const setup = () => {
  const db = getDb();
  return { db, repo: new Repo(db) };
};

const readMessage = async (db: Db, messageId: number) =>
  (await db.query<Record<string, string | number | null>>(
    `SELECT * FROM messages WHERE message_id = $1`,
    [messageId],
  )).rows[0]!;

describe('ingestMessages', () => {
  test('inserts a page once and is a no-op on re-ingest', async () => {
    const { repo } = setup();

    const first = await ingestMessages(repo, page());
    assert.deepEqual(
      { inserted: first.inserted, updated: first.updated },
      { inserted: 20, updated: 0 },
    );

    // The steady state: every 20s the same page comes back unchanged and must not write.
    const second = await ingestMessages(repo, page());
    assert.deepEqual(
      { inserted: second.inserted, updated: second.updated },
      { inserted: 0, updated: 0 },
    );
  });

  test('reports the id range including the deleted-post hole', async () => {
    const { repo } = setup();
    const result = await ingestMessages(repo, page());

    assert.equal(result.minId, 58348);
    assert.equal(result.maxId, 58368);
  });

  // @KozakChornobay edits every message as a target moves, so this is the routine path,
  // not an edge case: the revised text must replace the old one and go back in the
  // step-2 queue.
  test('rewrites an edited message and requeues it for parsing', async () => {
    const { db, repo } = setup();
    await ingestMessages(repo, page(), 1_000);

    await db.query(`UPDATE messages SET parse_state = 'parsed', parsed_at = 1000`);

    const edited = page().map((m) =>
      m.messageId === 58367 ? { ...m, text: 'БпЛА курсом на Лебедин' } : m,
    );
    const result = await ingestMessages(repo, edited, 2_000);

    assert.deepEqual(
      { inserted: result.inserted, updated: result.updated },
      { inserted: 0, updated: 1 },
    );

    const row = await readMessage(db, 58367);
    assert.equal(row['text'], 'БпЛА курсом на Лебедин');
    assert.equal(row['edited_at'], 2_000);
    assert.equal(row['parse_state'], 'pending', 'an edit must requeue the message');
    assert.equal(row['parsed_at'], null);

    const untouched = await readMessage(db, 58366);
    assert.equal(untouched['parse_state'], 'parsed', 'unchanged messages stay as they were');
    assert.equal(untouched['edited_at'], null);
  });

  test('stores an empty page without touching the database', async () => {
    const { repo } = setup();
    assert.deepEqual(await ingestMessages(repo, []), {
      inserted: 0,
      updated: 0,
      minId: null,
      maxId: null,
    });
  });

  test('flags impact and air-defence summaries at ingest', async () => {
    const { db, repo } = setup();
    await ingestMessages(repo, parsePage(fixture('kpszsu.html'), 'kpszsu'));

    // kpszsu/78115 is the daily summary carrying shoot-down and impact counts.
    assert.equal((await readMessage(db, 78115))['is_sensitive'], 1);
    // An ordinary target report must stay usable.
    assert.equal((await readMessage(db, 78128))['is_sensitive'], 0);
  });
});

describe('isSensitive', () => {
  test('flags impact and air-defence result wording', () => {
    for (const text of [
      'Зафіксовано влучання 10 ударних БпЛА противника.',
      'збито/подавлено 310 БпЛА',
      'Наслідки атаки уточнюються',
      'уламки впали на території підприємства',
    ]) {
      assert.ok(isSensitive(text), `should flag: ${text}`);
    }
  });

  test('leaves ordinary target reports alone', () => {
    for (const text of [
      'БпЛА курсом на Охтирку',
      '🛵 Сумщина: БпЛА в напрямку Охтирки з північного сходу.',
      'Одещина реактивний на Журівку',
      '',
    ]) {
      assert.ok(!isSensitive(text), `should not flag: ${text}`);
    }
  });
});
