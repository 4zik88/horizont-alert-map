import { Gazetteer, generateForms, type Place } from '@horizont/parser';
import type { Db } from './index.js';

/**
 * Load the whole gazetteer into memory. ~5,800 settlements and ~87k forms take well
 * under a second and a few MB, and every lookup after that is a Map hit instead of a
 * SQL round trip. Call it again after the toponym tables change.
 *
 * Forms are the stored ones *plus* a fresh generation from each name. The stored set
 * carries alternate spellings (an occupied town's Russian name) that the name column
 * does not; regenerating means a morphology fix takes effect on the next restart
 * instead of waiting for someone to rebuild the tables.
 */
export async function loadGazetteer(db: Db): Promise<Gazetteer> {
  // By id, so the in-memory order is deterministic (and the one SQLite's rowid scan gave).
  const { rows: places } = await db.query<Place>(
    `SELECT id, name, oblast, place, population, lat, lon, rank FROM toponyms ORDER BY id`,
  );
  const { rows } = await db.query<{ form: string; toponym_id: number }>(
    `SELECT form, toponym_id FROM toponym_forms`,
  );
  const forms = rows.map((r) => [r.form, r.toponym_id] as const);
  const fresh = places.flatMap((p) => generateForms(p.name).map((f) => [f, p.id] as const));
  return new Gazetteer(places, dedupe([...forms, ...fresh]));
}

function dedupe(forms: (readonly [string, number])[]): (readonly [string, number])[] {
  const seen = new Set<string>();
  return forms.filter(([form, id]) => {
    const key = `${id} ${form}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
