import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Db } from './index.js';
import { logger } from '../logger.js';
import { generateForms, normalise } from '../parser/morphology.js';

/**
 * Seed the gazetteer on an empty database.
 *
 * Without this a fresh deploy is silently useless. Railway starts with an empty
 * volume, migrations create the tables, the service reports healthy — and the parser
 * resolves no place name at all, so no target ever gets coordinates and no warning is
 * ever sent. Nothing errors; it just never works.
 *
 * Rebuilding from Overpass is not a viable boot step: it is heavily rate-limited and
 * took hours of retries to assemble here. So the 5,756 settlements ship with the
 * repo, and the ~87k inflected forms are regenerated on import rather than stored —
 * morphology is deterministic, and generating them takes a second against the ten
 * times larger file it would otherwise be.
 */
const SEED_PATH = 'seed/gazetteer.json';

interface Seed {
  columns: string[];
  rows: [number | null, string, string | null, string, number, number, number][];
}

const PLACE_WEIGHT: Record<string, number> = { city: 4, town: 3, village: 2, hamlet: 1 };

/** Same ranking `scripts/build-toponyms.ts` uses, so a seeded DB resolves identically. */
function rankOf(place: string, population: number): number {
  return (PLACE_WEIGHT[place] ?? 0) * 10_000_000 + population;
}

export function seedGazetteerIfEmpty(db: Db, path = SEED_PATH): number {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM toponyms').get() as { n: number };
  if (existing.n > 0) return 0;

  let seed: Seed;
  try {
    seed = JSON.parse(readFileSync(resolve(path), 'utf8')) as Seed;
  } catch (error) {
    // Loud, because the service will come up healthy and resolve nothing.
    logger.error(
      { path, err: error instanceof Error ? error.message : String(error) },
      'gazetteer seed missing — the parser will resolve no place names',
    );
    return 0;
  }

  const insertToponym = db.prepare(`
    INSERT INTO toponyms (osm_id, name, name_norm, oblast, place, population, lat, lon, rank)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertForm = db.prepare(
    'INSERT OR IGNORE INTO toponym_forms (form, toponym_id) VALUES (?, ?)',
  );

  let forms = 0;
  db.transaction(() => {
    for (const [osmId, name, oblast, place, population, lat, lon] of seed.rows) {
      const info = insertToponym.run(
        osmId, name, normalise(name), oblast, place, population, lat, lon,
        rankOf(place, population),
      );
      const id = Number(info.lastInsertRowid);
      for (const form of generateForms(name)) {
        insertForm.run(form, id);
        forms++;
      }
    }
  })();

  logger.info({ toponyms: seed.rows.length, forms }, 'gazetteer seeded');
  return seed.rows.length;
}
