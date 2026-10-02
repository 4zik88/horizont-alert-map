import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Db } from './index.js';
import { logger } from '../logger.js';
import { insertToponyms, type ToponymInput } from './toponyms.js';
import { generateForms, normalise, rankOf } from '@horizont/parser';
import { geoDataPath } from '@horizont/geo/node';

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
const SEED_PATH = geoDataPath('gazetteer.json');

interface Seed {
  columns: string[];
  rows: [number | null, string, string | null, string, number, number, number][];
}

export async function seedGazetteerIfEmpty(db: Db, path = SEED_PATH): Promise<number> {
  const { rows } = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM toponyms');
  if (rows[0]!.n > 0) return 0;

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

  const entries: ToponymInput[] = seed.rows.map(
    ([osmId, name, oblast, place, population, lat, lon]) => ({
      osmId, name, nameNorm: normalise(name), oblast, place, population, lat, lon,
      rank: rankOf(place, population),
      forms: generateForms(name),
    }),
  );

  const { forms } = await db.transaction((tx) => insertToponyms(tx, entries));

  logger.info({ toponyms: seed.rows.length, forms }, 'gazetteer seeded');
  return seed.rows.length;
}
