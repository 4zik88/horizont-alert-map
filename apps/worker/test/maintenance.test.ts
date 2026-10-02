import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { Maintenance, pruneLlmCache, pruneMessages, pruneNoticeLedger } from '../src/maintenance/index.js';
import { Repo } from '../src/db/repo.js';
import { scalar, useTestDb } from './helpers.js';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

const getDb = useTestDb();

describe('retention', () => {
  /*
   * The cascade is the point: a message must take its targets with it, or the map
   * keeps drawing things whose source text is gone.
   */
  test('deletes old messages and everything derived from them', async () => {
    const db = getDb();
    const repo = new Repo(db);
    await repo.ensureChannel('kpszsu');

    const insert = async (messageId: number, postedAt: number) => {
      await repo.tryInsertMessage({
        channel: 'kpszsu', messageId, postedAt, fetchedAt: postedAt,
        text: 'БпЛА на Охтирку', textHtml: null, contentHash: `h${messageId}`,
        hasMedia: 0, isSensitive: 0,
      });
      const id = await scalar(db, 'SELECT id FROM messages WHERE message_id = $1', [messageId]);
      await repo.saveTargets(id, [{
        messageId: id, type: 'uav', rawType: null, count: 1, oblast: null,
        relation: 'towards', fromName: null, fromLat: null, fromLon: null,
        toName: 'Охтирка', toLat: 50.3, toLon: 34.9, courseDeg: null,
        confidence: 0.9, source: 'rules', observedAt: postedAt, createdAt: postedAt,
      }], 'parsed', postedAt, 1);
    };

    await insert(1, NOW - 100 * DAY);
    await insert(2, NOW - 10 * DAY);

    const removed = await pruneMessages(db, 90 * DAY, NOW);

    assert.equal(removed, 1);
    assert.equal(await scalar(db, 'SELECT COUNT(*) FROM messages'), 1);
    assert.equal(await scalar(db, 'SELECT COUNT(*) FROM targets'), 1);
  });
});

describe('maintenance schedule', () => {
  const options = {
    retentionMs: 90 * DAY,
    intervalMs: DAY,
  };

  test('runs when due and not again until the interval has passed', async () => {
    const m = new Maintenance(getDb(), options);

    // No record of a previous run: the first check should do the work.
    assert.equal(await m.runIfDue(NOW), true);
    assert.equal(await m.runIfDue(NOW + 60_000), false);
    assert.equal(await m.runIfDue(NOW + DAY), true);
  });

  /*
   * The state lives in the database, so a restart neither repeats the work nor waits
   * a fresh full day before doing it — the failure mode of a plain interval timer in
   * a process that redeploys often.
   */
  test('the due time survives a restart', async () => {
    const db = getDb();
    await new Maintenance(db, options).runIfDue(NOW);

    assert.equal(await new Maintenance(db, options).runIfDue(NOW + 60_000), false);
    assert.equal(await new Maintenance(db, options).runIfDue(NOW + DAY + 1), true);
  });
});

/*
 * The subject-keyed ledger has no foreign key to cascade from, unlike the target-id
 * table it replaced. Without an age sweep it would grow for the life of the volume.
 */
describe('pruneNoticeLedger', () => {
  test('forgets warnings older than a day and keeps recent ones', async () => {
    const db = getDb();
    const now = 1_700_000_000_000;
    const insert = (chatId: number, subject: string, km: number, sentAt: number) =>
      db.query(
        `INSERT INTO notice_ledger (chat_id, subject, distance_km, sent_at) VALUES ($1, $2, $3, $4)`,
        [chatId, subject, km, sentAt],
      );
    await insert(1, 'uav|Охтирка|in_radius', 12, now - 2 * 86_400_000);
    await insert(1, 'uav|Суми|in_radius', 30, now - 60_000);

    assert.equal(await pruneNoticeLedger(db, now), 1);
    const { rows: left } = await db.query<{ subject: string }>('SELECT subject FROM notice_ledger');
    assert.deepEqual(left.map((r) => r.subject), ['uav|Суми|in_radius']);
  });
});

/*
 * Model answers are kept for a month. Without the sweep the cache would grow for the
 * life of the database, one row per distinct unresolved text.
 */
describe('pruneLlmCache', () => {
  test('forgets answers older than thirty days and keeps recent ones', async () => {
    const db = getDb();
    const insert = (hash: string, createdAt: number) =>
      db.query(
        `INSERT INTO llm_cache (content_hash, provider, targets, created_at) VALUES ($1, 'fake', '[]', $2)`,
        [hash, createdAt],
      );
    await insert('old', NOW - 31 * DAY);
    await insert('new', NOW - 1 * DAY);

    assert.equal(await pruneLlmCache(db, NOW), 1);
    const { rows } = await db.query<{ content_hash: string }>('SELECT content_hash FROM llm_cache');
    assert.deepEqual(rows.map((r) => r.content_hash), ['new']);
  });
});
