import { generateForms, normalise } from './morphology.js';
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
  /** 1.0 unique, lower when several settlements share the name or the match was fuzzy. */
  confidence: number;
  /** Edit distance of a fuzzy match; absent for exact form hits. */
  fuzzy?: number;
}

/** A settlement before it has an id or a rank, as seeds and test fixtures describe it. */
export interface SeedPlace {
  name: string;
  oblast?: string | null;
  place?: string;
  population?: number;
  lat: number;
  lon: number;
}

const PLACE_WEIGHT: Record<string, number> = { city: 4, town: 3, village: 2, hamlet: 1 };

/** Settlement class first, then population. The same ranking every builder must use. */
export function rankOf(place: string, population: number): number {
  return (PLACE_WEIGHT[place] ?? 0) * 10_000_000 + population;
}

/*
 * Words that sit where a place name should be often enough to be worth refusing
 * outright. Each of these was a top "unresolved destination" in the stored corpus, and
 * each is within two edits of some village, so without this list fuzzy matching would
 * turn "курсом на захід" into a pin on a hamlet.
 */
const FUZZY_STOPWORDS = new Set(
  [
    'містом', 'тепер', 'зараз', 'захід', 'схід', 'північ', 'південь', 'півночі', 'півдня',
    'заходу', 'сходу', 'північ', 'південний', 'північний', 'західний', 'східний',
    'напрямку', 'курсом', 'районі', 'район', 'області', 'область', 'кордон', 'кордону',
    'межі', 'межу', 'околиці', 'місто', 'міста', 'місті', 'села', 'село', 'селі',
    'бпла', 'шахед', 'шахеди', 'ракета', 'ракети', 'групи', 'група', 'ціль', 'цілі',
    'повз', 'через', 'вздовж', 'море', 'моря', 'морі', 'водосховище', 'водосховища',
    'відчуження', 'чорнобильської', 'обережно', 'увага', 'загроза', 'загрозу',
  ].map((w) => normalise(w)),
);

/** Levenshtein distance, giving up early once it must exceed `max`. */
export function boundedLevenshtein(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * Resolves settlement names against the gazetteer, held in memory.
 *
 * Three problems make this more than a dictionary lookup:
 *  - Names appear inflected ("на Охтирку"), handled by the generated form index.
 *  - 511 names are ambiguous nationally and 215 remain ambiguous even within one
 *    oblast, so a deterministic ranking (settlement class, then population) decides,
 *    and the confidence reported reflects how sure that choice is.
 *  - Channels misspell names. A bounded fuzzy match covers that, as a last resort and
 *    under stricter rules than an exact hit, because a wrong pin is worse than none.
 *
 * Storage-agnostic: whoever owns the database loads places and forms and hands them in.
 */
export class Gazetteer {
  private readonly places: Place[];
  private readonly byForm = new Map<string, Place[]>();
  /** first letter -> length -> forms; built on the first fuzzy lookup. */
  private fuzzyIndex: Map<string, Map<number, string[]>> | undefined;

  /** Misspelling fallback switch, for measuring what it adds. */
  fuzzyEnabled = true;

  /**
   * Largest edit distance the fallback accepts. The brief allowed 2; measured on the
   * stored corpus every distance-2 hit was a wrong place, so the default is 1.
   */
  fuzzyMaxDistance = 1;

  /** Diagnostics hook: called for every fuzzy resolution. */
  onFuzzy: ((phrase: string, hit: Resolution) => void) | undefined;

  constructor(places: Iterable<Place>, forms: Iterable<readonly [string, number]>) {
    this.places = [...places];
    const byId = new Map(this.places.map((p) => [p.id, p]));

    for (const [form, id] of forms) {
      const place = byId.get(id);
      if (!place) continue;
      const list = this.byForm.get(form);
      if (list) list.push(place);
      else this.byForm.set(form, [place]);
    }
    for (const list of this.byForm.values()) {
      list.sort((a, b) => b.rank - a.rank || a.id - b.id);
    }
  }

  /** Build from plain settlements, generating ids, ranks and inflected forms. */
  static fromSeed(seed: readonly SeedPlace[]): Gazetteer {
    const places: Place[] = seed.map((p, i) => {
      const place = p.place ?? 'town';
      const population = p.population ?? 5000;
      return {
        id: i + 1,
        name: p.name,
        oblast: p.oblast ?? null,
        place,
        population,
        lat: p.lat,
        lon: p.lon,
        rank: rankOf(place, population),
      };
    });
    const forms = places.flatMap((p) => generateForms(p.name).map((f) => [f, p.id] as const));
    return new Gazetteer(places, forms);
  }

  get size(): number {
    return this.places.length;
  }

  private candidates(form: string): Place[] {
    return this.byForm.get(form) ?? [];
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
    //
    // Kyiv is the exception: it is both a region and the most-reported city in the
    // country. Resolving it as a region gave every Kyiv target confidence 0.5 and
    // kept it out of the settlement ranking entirely, so "в р-ні Вишгорода у
    // напрямку Києва" could never pair an origin with a destination.
    const oblast = matchOblast(cleaned) ?? matchOblast(cleaned.split(/\s+/)[0] ?? '');
    if (oblast && !oblast.cityRegion) {
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
      return pick(candidates, contextOblast, 1);
    }

    // A city region whose name is not in the gazetteer still resolves as a region.
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

    if (!this.fuzzyEnabled) return undefined;
    // "Чорний Кут" must not shrink to "Чорний" and land on a village called Чорна: a
    // capitalised next word, not set off by a comma, is part of the same name.
    const rawWords = phrase.trim().split(/\s+/);
    const nameContinues =
      rawWords.length > 1 && !/[,;]$/.test(rawWords[0]!) && /^[А-ЯҐЄІЇ]/u.test(rawWords[1]!);
    for (let take = Math.min(words.length, 2); take >= (nameContinues ? 2 : 1); take--) {
      const phraseNorm = normalise(words.slice(0, take).join(' '));
      const hit = this.fuzzy(phraseNorm, contextOblast);
      if (hit) {
        this.onFuzzy?.(phraseNorm, hit);
        return hit;
      }
    }

    return undefined;
  }

  /**
   * Misspelling fallback, under stricter rules than an exact hit:
   *  - only under an oblast heading, and only for a settlement in that oblast;
   *  - at least 5 letters, first letter equal, distance ≤ fuzzyMaxDistance
   *    (and never 2 below 8 letters).
   * Measured on the stored corpus, every hit without an oblast heading was wrong —
   * "Бугаз" near Odesa became "Бугас" in Donetsk oblast. Anything looser invents pins.
   */
  private fuzzy(phrase: string, contextOblast: string | null | undefined): Resolution | undefined {
    if (!contextOblast) return undefined;
    if (phrase.length < 5 || FUZZY_STOPWORDS.has(phrase)) return undefined;
    const max = Math.min(this.fuzzyMaxDistance, phrase.length >= 8 ? 2 : 1);
    const index = this.buildFuzzyIndex();
    const byLength = index.get(phrase[0]!);
    if (!byLength) return undefined;

    let best = max + 1;
    let forms: string[] = [];
    for (let len = phrase.length - max; len <= phrase.length + max; len++) {
      for (const form of byLength.get(len) ?? []) {
        const d = boundedLevenshtein(phrase, form, Math.min(max, best));
        if (d > max) continue;
        if (d < best) {
          best = d;
          forms = [form];
        } else if (d === best) {
          forms.push(form);
        }
      }
    }
    if (best > max || best === 0) return undefined;

    const seen = new Set<number>();
    let candidates = forms
      .flatMap((f) => this.candidates(f))
      .filter((p) => !seen.has(p.id) && seen.add(p.id))
      .sort((a, b) => b.rank - a.rank || a.id - b.id);

    candidates = candidates.filter((c) => c.oblast === contextOblast);
    if (candidates.length === 0) return undefined;

    const hit = pick(candidates, contextOblast, best === 1 ? 0.7 : 0.55);
    return { ...hit, fuzzy: best };
  }

  private buildFuzzyIndex(): Map<string, Map<number, string[]>> {
    if (this.fuzzyIndex) return this.fuzzyIndex;
    const index = new Map<string, Map<number, string[]>>();
    for (const form of this.byForm.keys()) {
      const first = form[0];
      if (!first) continue;
      let byLength = index.get(first);
      if (!byLength) index.set(first, (byLength = new Map()));
      const list = byLength.get(form.length);
      if (list) list.push(form);
      else byLength.set(form.length, [form]);
    }
    this.fuzzyIndex = index;
    return index;
  }

  /**
   * Oblast containing a point, via the nearest known settlement.
   *
   * Used to decide which region's air-raid alert concerns a user. A polygon lookup
   * would be exact, but the gazetteer is already in memory and its oblast tags come
   * from official KATOTTH codes, so the nearest of ~5,700 settlements agrees with the
   * true region except within a few km of a border — which is close enough for
   * "should this person hear the Sumy oblast all-clear".
   */
  nearestOblast(lat: number, lon: number): string | null {
    // Equirectangular distance is monotonic with true distance at this scale, so
    // ordering by it picks the same nearest point as haversine without the trig.
    // The 0.41 factor is cos(50 deg), Ukraine's mid-latitude, squared.
    let best: Place | undefined;
    let bestD = Infinity;
    for (const p of this.places) {
      if (p.oblast === null) continue;
      const d = (p.lat - lat) ** 2 + (p.lon - lon) ** 2 * 0.41;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best?.oblast ?? null;
  }

  /** Coarse position for a bare oblast mention. */
  centreOf(oblastKey: string): { lat: number; lon: number } | undefined {
    const oblast = oblastByKey(oblastKey);
    return oblast ? { lat: oblast.centreLat, lon: oblast.centreLon } : undefined;
  }
}

function pick(
  candidates: Place[],
  contextOblast: string | null | undefined,
  factor: number,
): Resolution {
  const inOblast = contextOblast ? candidates.filter((c) => c.oblast === contextOblast) : [];
  const pool = inOblast.length > 0 ? inOblast : candidates;
  const best = pool[0]!;
  return {
    name: best.name,
    lat: best.lat,
    lon: best.lon,
    oblast: best.oblast,
    kind: 'settlement',
    confidence: confidenceOf(pool.length, inOblast.length > 0) * factor,
  };
}

function confidenceOf(poolSize: number, narrowedByOblast: boolean): number {
  if (poolSize === 1) return narrowedByOblast ? 1 : 0.95;
  if (poolSize <= 3) return narrowedByOblast ? 0.8 : 0.6;
  return narrowedByOblast ? 0.6 : 0.4;
}
