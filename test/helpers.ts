import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/migrations.js';
import { Repo } from '../src/db/repo.js';

export function memoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function memoryRepo(): { db: Database.Database; repo: Repo } {
  const db = memoryDb();
  return { db, repo: new Repo(db) };
}

export const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
