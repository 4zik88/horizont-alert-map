import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/migrations.js';
import { Repo } from '../src/db/repo.js';
import { generateForms, normalise } from '@horizont/parser';

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

export interface SeedPlace {
  name: string;
  oblast?: string | null;
  place?: string;
  population?: number;
  lat: number;
  lon: number;
}

const PLACE_WEIGHT: Record<string, number> = { city: 4, town: 3, village: 2, hamlet: 1 };

/** Seed a miniature gazetteer so parser tests do not depend on the real OSM build. */
export function seedGazetteer(db: Database.Database, places: SeedPlace[]): void {
  const insert = db.prepare(`
    INSERT INTO toponyms (name, name_norm, oblast, place, population, lat, lon, rank)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertForm = db.prepare(
    `INSERT OR IGNORE INTO toponym_forms (form, toponym_id) VALUES (?, ?)`,
  );

  for (const p of places) {
    const place = p.place ?? 'town';
    const population = p.population ?? 5000;
    const info = insert.run(
      p.name,
      normalise(p.name),
      p.oblast ?? null,
      place,
      population,
      p.lat,
      p.lon,
      (PLACE_WEIGHT[place] ?? 0) * 10_000_000 + population,
    );
    for (const form of generateForms(p.name)) insertForm.run(form, Number(info.lastInsertRowid));
  }
}

/** Channel HTML pages live with the parser that reads them; everything else lives here. */
export const fixture = (name: string): string =>
  readFileSync(
    name.endsWith('.html')
      ? join(import.meta.dirname, '..', '..', '..', 'packages', 'parser', 'test', 'fixtures', name)
      : join(import.meta.dirname, 'fixtures', name),
    'utf8',
  );
