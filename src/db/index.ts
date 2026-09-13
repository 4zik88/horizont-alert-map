import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from './migrations.js';
import { logger } from '../logger.js';

export type Db = Database.Database;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);

  // WAL: the step-4 HTTP readers never block the poller's writes.
  db.pragma('journal_mode = WAL');
  // WAL + NORMAL is the right durability/IO trade-off on a Railway volume.
  db.pragma('synchronous = NORMAL');
  // Off by default in SQLite; the targets -> messages cascade depends on it.
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  const version = migrate(db, (m) =>
    logger.info({ version: m.version, name: m.name }, 'migration applied'),
  );
  logger.debug({ path, schemaVersion: version }, 'database ready');

  return db;
}

export function closeDb(db: Db): void {
  // Checkpoints the WAL back into the main file so a redeploy leaves it clean.
  db.close();
}
