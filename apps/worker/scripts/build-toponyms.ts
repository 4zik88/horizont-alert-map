/**
 * Builds the all-Ukraine gazetteer from OpenStreetMap via Overpass.
 *
 * Run once, then again whenever you want fresher data:
 *   npm run build:toponyms
 *
 * Covers every city and town (which includes all raion centres) plus villages and
 * hamlets. The country-wide village query exceeds Overpass's result limit and comes
 * back *empty rather than erroring*, so the fetch is chunked into latitude bands
 * and every chunk is asserted non-empty before it counts as a success.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../src/config.js';
import { closeDb, openDb } from '../src/db/index.js';
import { logger } from '../src/logger.js';
import { insertToponyms, type ToponymInput } from '../src/db/toponyms.js';
import { generateForms, normalise } from '@horizont/parser';
import { CODE_TO_OBLAST } from '@horizont/parser';

const ENDPOINTS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
];

interface OverpassNode {
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function overpass(
  query: string,
  label: string,
  retryOnEmpty: boolean,
): Promise<OverpassNode[]> {
  let lastError = '';
  const attempts = retryOnEmpty ? 6 : 3;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const endpoint = ENDPOINTS[attempt % ENDPOINTS.length]!;
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        body: query,
        signal: AbortSignal.timeout(600_000),
        headers: { 'content-type': 'text/plain', 'user-agent': 'horizont-alert/0.1 gazetteer build' },
      });

      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
      } else {
        const body = (await response.json()) as { elements?: OverpassNode[] };
        const elements = body.elements ?? [];
        // An over-large query returns 200 with an empty list rather than an error,
        // so treat "no elements" as a failure to retry, not as a valid answer.
        if (elements.length > 0) {
          logger.info({ label, attempt: attempt + 1, elements: elements.length }, 'overpass chunk');
          return elements;
        }
        // Caller can subdivide, so don't burn retries on what is probably an
        // over-large query rather than a transient failure.
        if (!retryOnEmpty) return [];
        lastError = 'empty result (query too large or rate-limited)';
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    if (attempt === attempts - 1) break;
    const backoff = 8_000 * 2 ** attempt;
    logger.warn({ label, attempt: attempt + 1, reason: lastError, backoff }, 'overpass retry');
    await sleep(backoff);
  }

  if (!retryOnEmpty) {
    logger.warn({ label, reason: lastError }, 'cell unavailable, continuing');
    return [];
  }
  throw new Error(`overpass failed for ${label}: ${lastError}`);
}

function population(tags: Record<string, string>): number {
  const digits = (tags['population'] ?? '').replace(/[^0-9]/g, '');
  return digits ? Number.parseInt(digits, 10) : 0;
}

/** KATOTTH ("UA74...") and KOATUU ("7410100000") both encode the oblast in two digits. */
function oblastOf(tags: Record<string, string>): string | null {
  const katotth = tags['katotth'] ?? '';
  if (katotth.startsWith('UA') && katotth.length > 4) {
    const key = CODE_TO_OBLAST[katotth.slice(2, 4)];
    if (key) return key;
  }
  const koatuu = tags['koatuu'] ?? '';
  if (koatuu.length >= 2) {
    const key = CODE_TO_OBLAST[koatuu.slice(0, 2)];
    if (key) return key;
  }
  return null;
}

const PLACE_WEIGHT: Record<string, number> = { city: 4, town: 3, village: 2, hamlet: 1 };

/**
 * Ranking for ambiguity resolution: settlement class dominates, population breaks
 * ties within a class. A town called Дмитрівка always beats a hamlet of the same name.
 */
function rankOf(place: string, pop: number): number {
  return (PLACE_WEIGHT[place] ?? 0) * 10_000_000 + Math.min(pop, 9_999_999);
}

/**
 * Fetched cells are cached on disk as they arrive.
 *
 * The whole build is 15+ Overpass queries against a free public endpoint and can take
 * half an hour when it is busy; without a cache, one failure late in the run throws
 * away everything fetched so far. Re-running resumes instead of restarting. Delete
 * the file (or pass FRESH=1) to force a full refetch.
 */
const CACHE_PATH = 'data/.overpass-cache.json';

function loadCache(): Record<string, OverpassNode[]> {
  if (process.env['FRESH'] === '1' || !existsSync(CACHE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as Record<string, OverpassNode[]>;
  } catch {
    logger.warn('overpass cache unreadable, refetching');
    return {};
  }
}

function saveCache(cache: Record<string, OverpassNode[]>): void {
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(cache), 'utf8');
}

/**
 * Fetch the gazetteer: every city and town (which covers all raion centres), plus
 * villages of roughly 1,000+ people.
 *
 * The population filter is applied *inside* the Overpass query. Fetching all ~28k
 * villages and filtering locally does not work: the country-wide query exceeds
 * Overpass's limits and answers with HTTP 200 and an empty list rather than an
 * error, and chunking it geographically means dozens of requests against a free,
 * heavily rate-limited endpoint.
 *
 * Villages below the cutoff are occasionally used as waypoints, and those
 * destinations simply will not resolve — by design they fall through to the feed as
 * plain text rather than becoming a guessed marker. To trade coverage for
 * ambiguity, lower the bound in POPULATION_PATTERN.
 */
const POPULATION_PATTERN = '^[1-9][0-9]{3,}$'; // 1000 and above

async function collect(): Promise<OverpassNode[]> {
  const nodes = new Map<number, OverpassNode>();
  const cache = loadCache();

  const queries: { key: string; query: string }[] = [
    {
      key: 'cities+towns',
      query: `[out:json][timeout:600];
area["ISO3166-1"="UA"][admin_level=2]->.ua;
(node["place"="city"](area.ua);node["place"="town"](area.ua););
out body;`,
    },
    {
      key: 'villages',
      query: `[out:json][timeout:600];
area["ISO3166-1"="UA"][admin_level=2]->.ua;
node["place"="village"]["population"~"${POPULATION_PATTERN}"](area.ua);
out body;`,
    },
  ];

  for (const { key, query } of queries) {
    let elements = cache[key];
    if (elements) {
      logger.info({ key, cached: elements.length }, 'chunk from cache');
    } else {
      elements = await overpass(query, key, true);
      cache[key] = elements;
      saveCache(cache);
      await sleep(3_000);
    }
    for (const node of elements) nodes.set(node.id, node);
  }

  return [...nodes.values()];
}

async function main(): Promise<void> {
  const nodes = await collect();
  logger.info({ nodes: nodes.length }, 'overpass fetch complete');

  const db = await openDb(config.DATABASE_URL);
  try {
    const entries: ToponymInput[] = [];

    for (const node of nodes) {
      const tags = node.tags ?? {};
      /*
       * `name:uk` first, `name` second.
       *
       * In occupied territory OSM's `name` is Russian — Crimea comes through as
       * Гвардейское, Керчь, Євпаторія as Евпатория — while the channels write
       * Ukrainian throughout. 327 places were indexed under a spelling that never
       * appears in a message, so a launch reported from the Hvardiiske airbase
       * matched a same-named village in Khmelnytskyi oblast instead and drew a
       * marker 600 km from the real place.
       */
      const name = tags['name:uk'] ?? tags['name'];
      const place = tags['place'];
      if (!name || !place) continue;
      // Latin-only names are transliterations of somewhere else; skip them.
      if (!/[\p{Script=Cyrillic}]/u.test(name)) continue;

      const pop = population(tags);
      // Index the other spelling too: a message quoting the Russian name of an
      // occupied place should still resolve.
      const spellings = new Set([name, tags['name'], tags['name:uk']].filter(
        (v): v is string => typeof v === 'string' && /[\p{Script=Cyrillic}]/u.test(v),
      ));
      entries.push({
        osmId: node.id,
        name,
        nameNorm: normalise(name),
        oblast: oblastOf(tags),
        place,
        population: pop,
        lat: node.lat,
        lon: node.lon,
        rank: rankOf(place, pop),
        forms: [...spellings].flatMap((spelling) => generateForms(spelling)),
      });
    }

    // Replaced wholesale, in one transaction: a crash midway leaves the old gazetteer.
    const { toponyms, forms } = await db.transaction(async (tx) => {
      await tx.exec('DELETE FROM toponym_forms; DELETE FROM toponyms;');
      return insertToponyms(tx, entries);
    });

    await db.exec('ANALYZE toponyms; ANALYZE toponym_forms;');
    logger.info({ toponyms, forms }, 'gazetteer built');
  } finally {
    await closeDb(db);
  }
}

void main();
