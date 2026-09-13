import type { Db } from '../db/index.js';
import { normalise } from './morphology.js';
import { matchOblast, oblastByKey } from './oblasts.js';

export interface Place {
  id: number;
  name: string;
  oblast: string | null;
  place: string;
  population: number;
  lat: number;
  lon: number;
  rank: number;
}

export interface Resolution {
  name: string;
  lat: number;
  lon: number;
  oblast: string | null;
  /** `oblast` means only a region was named, so the position is its centre — much coarser. */
  kind: 'settlement' | 'oblast';
  /** 1.0 unique, lower when several settlements share the name. */
  confidence: number;
}

/**
 * Resolves settlement names against the gazetteer.
 *
 * Two problems make this more than a dictionary lookup:
 *  - Names appear inflected ("на Охтирку"), handled by the generated form index.
 *  - 511 names are ambiguous nationally and 215 remain ambiguous even within one
 *    oblast, so a deterministic ranking (settlement class, then population) decides,
 *    and the confidence reported reflects how sure that choice is.
 */
export class Gazetteer {
  private readonly byForm;
  private readonly cache = new Map<string, Place[]>();

  constructor(db: Db) {
    this.byForm = db.prepare(`
      SELECT t.id, t.name, t.oblast, t.place, t.population, t.lat, t.lon, t.rank
        FROM toponym_forms f
        JOIN toponyms t ON t.id = f.toponym_id
       WHERE f.form = ?
       ORDER BY t.rank DESC
    `);
  }

  private candidates(form: string): Place[] {
    let hit = this.cache.get(form);
    if (!hit) {
      hit = this.byForm.all(form) as Place[];
      this.cache.set(form, hit);
    }
    return hit;
  }

  /**
   * Resolve a phrase to a position.
   *
   * `contextOblast` is the sticky heading the line sits under; it is the main
   * disambiguator, which is why oblast headings are parsed before target lines.
   */
  resolve(phrase: string, contextOblast?: string | null): Resolution | undefined {
    const cleaned = phrase.replace(/[«»"(),.;:!?]/g, ' ').trim();
    if (!cleaned) return undefined;

    // A region name is a valid, if coarse, answer: "КАБи на Дніпропетровщину".
    const oblast = matchOblast(cleaned) ?? matchOblast(cleaned.split(/\s+/)[0] ?? '');
    if (oblast) {
      return {
        name: oblast.name,
        lat: oblast.centreLat,
        lon: oblast.centreLon,
        oblast: oblast.key,
        kind: 'oblast',
        confidence: 0.5,
      };
    }

    // Try the longest phrase first so "Липову Долину" wins over "Липову".
    const words = cleaned.split(/\s+/);
    for (let take = Math.min(words.length, 3); take >= 1; take--) {
      const candidates = this.candidates(normalise(words.slice(0, take).join(' ')));
      if (candidates.length === 0) continue;

      const inOblast = contextOblast
        ? candidates.filter((c) => c.oblast === contextOblast)
        : [];
      const pool = inOblast.length > 0 ? inOblast : candidates;
      const best = pool[0]!;

      return {
        name: best.name,
        lat: best.lat,
        lon: best.lon,
        oblast: best.oblast,
        kind: 'settlement',
        confidence: confidenceOf(pool.length, inOblast.length > 0),
      };
    }

    return undefined;
  }

  /** Coarse position for a bare oblast mention. */
  centreOf(oblastKey: string): { lat: number; lon: number } | undefined {
    const oblast = oblastByKey(oblastKey);
    return oblast ? { lat: oblast.centreLat, lon: oblast.centreLon } : undefined;
  }
}

function confidenceOf(poolSize: number, narrowedByOblast: boolean): number {
  if (poolSize === 1) return narrowedByOblast ? 1 : 0.95;
  if (poolSize <= 3) return narrowedByOblast ? 0.8 : 0.6;
  return narrowedByOblast ? 0.6 : 0.4;
}
