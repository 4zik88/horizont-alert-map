import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { MIGRATIONS, migrate } from '@horizont/db';
import { useTestDb } from './helpers.js';

/** Every table the worker reads or writes. */
const WORKER_TABLES = [
  'app_state', 'channel_state', 'llm_cache', 'messages', 'notice_ledger', 'oblast_alerts',
  'raion_alerts', 'targets', 'toponym_forms', 'toponyms', 'users',
];

const db = useTestDb();

describe('migrations', () => {
  test('creates every table the worker uses and records the version', async () => {
    const { rows } = await db().query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    const tables = rows.map((r) => r.tablename);
    for (const table of WORKER_TABLES) {
      assert.ok(tables.includes(table), `missing table ${table}`);
    }

    const { rows: [applied] } = await db().query<{ v: number }>(
      'SELECT MAX(version) AS v FROM schema_migrations',
    );
    assert.equal(applied!.v, MIGRATIONS.at(-1)?.version);
  });

  test('is idempotent across repeated boots', async () => {
    const applied: number[] = [];
    const version = await migrate(db(), (m) => applied.push(m.version));

    assert.deepEqual(applied, [], 'a second run must apply nothing');
    assert.equal(version, MIGRATIONS.at(-1)?.version);
  });

  test('creates the dedup index the poller relies on', async () => {
    const { rows } = await db().query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const indexes = rows.map((r) => r.indexname);

    assert.ok(indexes.includes('ux_messages_channel_post'));
    assert.ok(indexes.includes('ix_messages_parse_queue'));
    assert.ok(indexes.includes('ix_targets_observed_at'));
    assert.ok(indexes.includes('ix_toponyms_name_norm'));
  });

  test('enforces the parse_state check constraint', async () => {
    await assert.rejects(
      db().query(
        `INSERT INTO messages (channel, message_id, posted_at, fetched_at, content_hash, parse_state)
         VALUES ('x', 1, 1, 1, 'h', 'bogus')`,
      ),
      /check constraint/i,
    );
  });
});
