import type { Db } from './index.js';

/** One settlement to store, with every form it should be found under. */
export interface ToponymInput {
  osmId: number | null;
  name: string;
  nameNorm: string;
  oblast: string | null;
  place: string;
  population: number;
  lat: number;
  lon: number;
  rank: number;
  forms: string[];
}

const TOPONYM_CHUNK = 5_000;
const FORM_CHUNK = 20_000;

/**
 * Bulk-insert toponyms and their forms. Pass a transaction handle.
 *
 * ~5.8k settlements carry ~88k forms; one statement per row is minutes over a network
 * link, so rows go in as arrays through `unnest` — a handful of statements in all.
 *
 * Ids are drawn from the sequence up front and assigned in input order, so each form
 * knows its toponym's id without relying on the order RETURNING happens to use, and
 * ids ascend in input order exactly as the one-row-at-a-time inserts did (the
 * gazetteer breaks rank ties by id).
 *
 * `forms` counts every form offered, duplicates included, as the per-row inserts did.
 */
export async function insertToponyms(
  tx: Db,
  entries: readonly ToponymInput[],
): Promise<{ toponyms: number; forms: number; ids: number[] }> {
  if (entries.length === 0) return { toponyms: 0, forms: 0, ids: [] };

  const { rows } = await tx.query<{ id: number }>(
    `SELECT nextval(pg_get_serial_sequence('toponyms', 'id')) AS id FROM generate_series(1, $1)`,
    [entries.length],
  );
  const ids = rows.map((r) => r.id).sort((a, b) => a - b);

  for (let start = 0; start < entries.length; start += TOPONYM_CHUNK) {
    const chunk = entries.slice(start, start + TOPONYM_CHUNK);
    await tx.query(
      `INSERT INTO toponyms (id, osm_id, name, name_norm, oblast, place, population, lat, lon, rank)
       SELECT * FROM unnest(
         $1::bigint[], $2::bigint[], $3::text[], $4::text[], $5::text[], $6::text[],
         $7::integer[], $8::float8[], $9::float8[], $10::bigint[])`,
      [
        ids.slice(start, start + chunk.length),
        chunk.map((e) => e.osmId),
        chunk.map((e) => e.name),
        chunk.map((e) => e.nameNorm),
        chunk.map((e) => e.oblast),
        chunk.map((e) => e.place),
        chunk.map((e) => e.population),
        chunk.map((e) => e.lat),
        chunk.map((e) => e.lon),
        chunk.map((e) => e.rank),
      ],
    );
  }

  const forms: string[] = [];
  const formIds: number[] = [];
  entries.forEach((e, i) => {
    for (const form of e.forms) {
      forms.push(form);
      formIds.push(ids[i]!);
    }
  });

  for (let start = 0; start < forms.length; start += FORM_CHUNK) {
    await tx.query(
      `INSERT INTO toponym_forms (form, toponym_id)
       SELECT * FROM unnest($1::text[], $2::bigint[])
       ON CONFLICT DO NOTHING`,
      [forms.slice(start, start + FORM_CHUNK), formIds.slice(start, start + FORM_CHUNK)],
    );
  }

  return { toponyms: entries.length, forms: forms.length, ids };
}
