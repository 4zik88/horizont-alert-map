import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Maintenance, backupName, prune, pruneMessages, runBackup, pruneNoticeLedger } from '../src/maintenance/index.js';
import { Repo } from '../src/db/repo.js';
import { migrate } from '../src/db/migrations.js';
import { memoryDb } from './helpers.js';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

/**
 * A file-backed DB, because `VACUUM INTO` needs a real one to copy. Migrated like
 * the real thing, so the scheduler finds the `app_state` table it records into.
 */
function fileDb(dir: string): Database.Database {
  const db = new Database(join(dir, 'app.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) STRICT');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('kept');
  return db;
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'horizont-test-'));
}

describe('backup', () => {
  test('writes a readable copy of the database', () => {
    const dir = tmp();
    try {
      const db = fileDb(dir);
      const file = runBackup(db, { dir: join(dir, 'backups'), keep: 7 }, NOW);
      db.close();

      const restored = new Database(file, { readonly: true });
      const row = restored.prepare('SELECT v FROM t').get() as { v: string };
      assert.equal(row.v, 'kept');
      restored.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /*
   * A restart on the same day must not fail. VACUUM INTO refuses an existing
   * destination, so the previous copy is removed first — the newer one is simply
   * the better one.
   */
  test('a second run on the same day overwrites rather than throwing', () => {
    const dir = tmp();
    try {
      const db = fileDb(dir);
      const backups = join(dir, 'backups');
      runBackup(db, { dir: backups, keep: 7 }, NOW);
      runBackup(db, { dir: backups, keep: 7 }, NOW);
      db.close();
      assert.equal(readdirSync(backups).length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('keeps only the newest N backups', () => {
    const dir = tmp();
    try {
      for (let day = 0; day < 10; day++) {
        writeFileSync(join(dir, backupName(NOW - day * DAY)), 'x');
      }
      writeFileSync(join(dir, 'unrelated.txt'), 'x');

      const removed = prune(dir, 7);
      const left = readdirSync(dir).filter((f) => f.endsWith('.db')).sort();

      assert.equal(removed, 3);
      assert.equal(left.length, 7);
      // The newest survive; the name is an ISO date, so lexical order is chronological.
      assert.equal(left.at(-1), backupName(NOW));
      // Files that are not ours are never touched.
      assert.ok(readdirSync(dir).includes('unrelated.txt'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('retention', () => {
  /*
   * The cascade is the point: a message must take its targets with it, or the map
   * keeps drawing things whose source text is gone.
   */
  test('deletes old messages and everything derived from them', () => {
    const db = memoryDb();
    const repo = new Repo(db);
    repo.ensureChannel('kpszsu');

    const insert = (messageId: number, postedAt: number) => {
      repo.tryInsertMessage({
        channel: 'kpszsu', messageId, postedAt, fetchedAt: postedAt,
        text: 'БпЛА на Охтирку', textHtml: null, contentHash: `h${messageId}`,
        hasMedia: 0, isSensitive: 0,
      });
      const id = (db.prepare('SELECT id FROM messages WHERE message_id = ?')
        .get(messageId) as { id: number }).id;
      repo.saveTargets(id, [{
        messageId: id, type: 'uav', rawType: null, count: 1, oblast: null,
        relation: 'towards', fromName: null, fromLat: null, fromLon: null,
        toName: 'Охтирка', toLat: 50.3, toLon: 34.9, courseDeg: null,
        confidence: 0.9, source: 'rules', observedAt: postedAt, createdAt: postedAt,
      }], 'parsed', postedAt, 1);
    };

    insert(1, NOW - 100 * DAY);
    insert(2, NOW - 10 * DAY);

    const removed = pruneMessages(db, 90 * DAY, NOW);

    assert.equal(removed, 1);
    assert.equal((db.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c, 1);
    assert.equal((db.prepare('SELECT COUNT(*) c FROM targets').get() as { c: number }).c, 1);
  });
});

describe('maintenance schedule', () => {
  const options = (dir: string) => ({
    backup: { dir, keep: 7 },
    retentionMs: 90 * DAY,
    intervalMs: DAY,
  });

  test('runs when due and not again until the interval has passed', () => {
    const dir = tmp();
    try {
      const db = fileDb(dir);
      const m = new Maintenance(db, options(join(dir, 'backups')));

      // No record of a previous run: the first check should do the work.
      assert.equal(m.runIfDue(NOW), true);
      assert.equal(m.runIfDue(NOW + 60_000), false);
      assert.equal(m.runIfDue(NOW + DAY), true);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /*
   * The state lives in the database, so a restart neither repeats the work nor waits
   * a fresh full day before doing it — the failure mode of a plain interval timer in
   * a process that redeploys often.
   */
  test('the due time survives a restart', () => {
    const dir = tmp();
    try {
      const db = fileDb(dir);
      const opts = options(join(dir, 'backups'));
      new Maintenance(db, opts).runIfDue(NOW);

      assert.equal(new Maintenance(db, opts).runIfDue(NOW + 60_000), false);
      assert.equal(new Maintenance(db, opts).runIfDue(NOW + DAY + 1), true);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/*
 * The subject-keyed ledger has no foreign key to cascade from, unlike the target-id
 * table it replaced. Without an age sweep it would grow for the life of the volume.
 */
describe('pruneNoticeLedger', () => {
  test('forgets warnings older than a day and keeps recent ones', () => {
    const db = memoryDb();
    const now = 1_700_000_000_000;
    const insert = db.prepare(
      `INSERT INTO notice_ledger (chat_id, subject, distance_km, sent_at) VALUES (?, ?, ?, ?)`,
    );
    insert.run(1, 'uav|Охтирка|in_radius', 12, now - 2 * 86_400_000);
    insert.run(1, 'uav|Суми|in_radius', 30, now - 60_000);

    assert.equal(pruneNoticeLedger(db, now), 1);
    const left = db.prepare('SELECT subject FROM notice_ledger').all() as { subject: string }[];
    assert.deepEqual(left.map((r) => r.subject), ['uav|Суми|in_radius']);
  });
});
