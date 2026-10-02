import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, beforeEach } from 'node:test';
import { testDb, truncateAll } from '@horizont/db/testing';
import type { Db } from '../src/db/index.js';
import { insertToponyms } from '../src/db/toponyms.js';
import { Repo } from '../src/db/repo.js';
import { generateForms, normalise } from '@horizont/parser';

/*
 * Nothing imported here may load `src/config.ts` (directly or through the logger):
 * some test files set env vars before importing the code under test, and config
 * reads the environment exactly once.
 */

/** A fresh, migrated in-process Postgres (PGlite). Close it when done. */
export async function memoryDb(): Promise<Db> {
  return testDb();
}

export async function memoryRepo(): Promise<{ db: Db; repo: Repo }> {
  const db = await memoryDb();
  return { db, repo: new Repo(db) };
}

/**
 * One database for the whole test file, emptied before every test.
 *
 * Creating a PGlite instance costs ~0.5 s, so one per test would dominate the suite.
 * Call at the top level of a test file; the returned getter is valid inside tests.
 */
export function useTestDb(): () => Db {
  let db: Db | undefined;
  before(async () => {
    db = await testDb();
  });
  beforeEach(async () => {
    await truncateAll(db!);
  });
  after(async () => {
    await db?.close();
  });
  return () => {
    if (!db) throw new Error('useTestDb(): the database exists only inside tests and hooks');
    return db;
  };
}

/** First column of the first row — for `SELECT COUNT(*)`-style assertions. */
export async function scalar<T = number>(db: Db, text: string, params: unknown[] = []): Promise<T> {
  const { rows } = await db.query<Record<string, T>>(text, params);
  return Object.values(rows[0]!)[0]!;
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
export async function seedGazetteer(db: Db, places: SeedPlace[]): Promise<void> {
  await db.transaction((tx) =>
    insertToponyms(
      tx,
      places.map((p) => {
        const place = p.place ?? 'town';
        const population = p.population ?? 5000;
        return {
          osmId: null,
          name: p.name,
          nameNorm: normalise(p.name),
          oblast: p.oblast ?? null,
          place,
          population,
          lat: p.lat,
          lon: p.lon,
          rank: (PLACE_WEIGHT[place] ?? 0) * 10_000_000 + population,
          forms: generateForms(p.name),
        };
      }),
    ),
  );
}

/** Channel HTML pages live with the parser that reads them; everything else lives here. */
export const fixture = (name: string): string =>
  readFileSync(
    name.endsWith('.html')
      ? join(import.meta.dirname, '..', '..', '..', 'packages', 'parser', 'test', 'fixtures', name)
      : join(import.meta.dirname, 'fixtures', name),
    'utf8',
  );
