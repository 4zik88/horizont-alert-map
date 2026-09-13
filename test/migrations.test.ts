import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import Database from 'better-sqlite3';
import { MIGRATIONS, migrate } from '../src/db/migrations.js';

const tableNames = (db: Database.Database): string[] =>
  (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as {
    name: string;
  }[]).map((r) => r.name);

describe('migrations', () => {
  test('creates the full step-1 schema and records the version', () => {
    const db = new Database(':memory:');
    const version = migrate(db);

    assert.equal(version, MIGRATIONS.at(-1)?.version);
    assert.equal(db.pragma('user_version', { simple: true }), version);
    assert.deepEqual(tableNames(db), [
      'app_state', 'channel_state', 'messages', 'notifications', 'oblast_alerts',
      'targets', 'toponym_forms', 'toponyms', 'users',
    ]);
  });

  test('is idempotent across repeated boots', () => {
    const db = new Database(':memory:');
    migrate(db);

    const applied: number[] = [];
    const version = migrate(db, (m) => applied.push(m.version));

    assert.deepEqual(applied, [], 'a second run must apply nothing');
    assert.equal(version, MIGRATIONS.at(-1)?.version);
  });

  test('creates the dedup index the poller relies on', () => {
    const db = new Database(':memory:');
    migrate(db);

    const indexes = (db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as {
      name: string;
    }[]).map((r) => r.name);

    assert.ok(indexes.includes('ux_messages_channel_post'));
    assert.ok(indexes.includes('ix_messages_parse_queue'));
    assert.ok(indexes.includes('ix_targets_observed_at'));
    assert.ok(indexes.includes('ix_toponyms_name_norm'));
  });

  test('enforces the parse_state check constraint', () => {
    const db = new Database(':memory:');
    migrate(db);

    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO messages (channel, message_id, posted_at, fetched_at, content_hash, parse_state)
             VALUES ('x', 1, 1, 1, 'h', 'bogus')`,
          )
          .run(),
      /CHECK constraint failed/,
    );
  });
});
