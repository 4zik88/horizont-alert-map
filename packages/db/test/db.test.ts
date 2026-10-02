import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { appendEvent, eventsAfter, latestSeq, migrate, MIGRATIONS, pruneEvents } from '../src/index.js';
import { testDb, truncateAll } from '../src/testing.js';

describe('db', () => {
  test('migrates to the latest version, and a second run applies nothing', async () => {
    const sql = await testDb();
    const applied: number[] = [];
    const version = await migrate(sql, (m) => applied.push(m.version));
    assert.equal(version, MIGRATIONS.at(-1)!.version);
    assert.deepEqual(applied, []);
    await sql.close();
  });

  test('bigint columns come back as numbers', async () => {
    const sql = await testDb();
    await sql.query(
      `INSERT INTO messages (channel, message_id, posted_at, fetched_at, content_hash) VALUES ('c', 1, $1, $1, 'h')`,
      [1_790_000_000_000],
    );
    const { rows } = await sql.query<{ posted_at: unknown; id: unknown }>('SELECT id, posted_at FROM messages');
    assert.equal(typeof rows[0]!.posted_at, 'number');
    assert.equal(rows[0]!.posted_at, 1_790_000_000_000);
    assert.equal(typeof rows[0]!.id, 'number');
    await sql.close();
  });

  test('a rolled-back transaction leaves no event behind', async () => {
    const sql = await testDb();
    await assert.rejects(sql.transaction(async (tx) => {
      await appendEvent(tx, { type: 'alert.ended', alertId: 1, endedAt: 1 });
      throw new Error('boom');
    }));
    assert.equal(await latestSeq(sql), 0);
    await sql.close();
  });

  test('events notify on commit and replay by seq', async () => {
    const sql = await testDb();
    const heard: string[] = [];
    const stop = await sql.listen('events', (p) => heard.push(p));
    await sql.transaction((tx) => appendEvent(tx, { type: 'alert.ended', alertId: 7, endedAt: 2 }, 100));
    await sql.transaction((tx) => appendEvent(tx, { type: 'alert.ended', alertId: 8, endedAt: 3 }, 200));
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(heard, ['1', '2']);

    const after = await eventsAfter(sql, 1);
    assert.equal(after.length, 1);
    assert.deepEqual(after[0]!.e, { type: 'alert.ended', alertId: 8, endedAt: 3 });

    assert.equal(await pruneEvents(sql, 100, 260), 1, 'only the event older than 100 ms goes');
    await stop();
    await sql.close();
  });

  test('truncateAll empties tables and restarts ids', async () => {
    const sql = await testDb();
    await sql.transaction((tx) => appendEvent(tx, { type: 'alert.ended', alertId: 1, endedAt: 1 }));
    await truncateAll(sql);
    const seq = await sql.transaction((tx) => appendEvent(tx, { type: 'alert.ended', alertId: 1, endedAt: 1 }));
    assert.equal(seq, 1);
    await sql.close();
  });
});
