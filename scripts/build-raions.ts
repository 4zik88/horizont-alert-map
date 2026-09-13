/**
 * Builds simplified *raion* boundaries — the level at which air-raid alerts are
 * actually declared.
 *
 *   npm run build:raions
 *
 * Shading whole oblasts overstates an alert badly: when one raion of Kharkivska is
 * under warning, painting the entire region red claims an emergency across an area
 * the size of a small country. alerts.in.ua shades raions, and matching that is the
 * difference between a map people trust and one they learn to ignore.
 *
 * Fetched per oblast (26 queries) rather than country-wide, because the whole set at
 * once exceeds what Overpass will return. Resumable: every oblast is cached.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../src/logger.js';
import { normalise } from '../src/parser/morphology.js';

const ENDPOINTS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
];

const CACHE_PATH = 'data/.raions-cache.json';
const OUTPUT_PATH = 'public/data/raions.geojson';

const OBLAST_NAMES: Record<string, string> = {
  vinnytska: 'Вінницька область', volynska: 'Волинська область',
  dnipropetrovska: 'Дніпропетровська область', donetska: 'Донецька область',
  zhytomyrska: 'Житомирська область', zakarpatska: 'Закарпатська область',
  zaporizka: 'Запорізька область', 'ivano-frankivska': 'Івано-Франківська область',
  kyivska: 'Київська область', kirovohradska: 'Кіровоградська область',
  luhanska: 'Луганська область', lvivska: 'Львівська область',
  mykolaivska: 'Миколаївська область', odeska: 'Одеська область',
  poltavska: 'Полтавська область', rivnenska: 'Рівненська область',
  sumska: 'Сумська область', ternopilska: 'Тернопільська область',
  kharkivska: 'Харківська область', khersonska: 'Херсонська область',
  khmelnytska: 'Хмельницька область', cherkaska: 'Черкаська область',
  chernivetska: 'Чернівецька область', chernihivska: 'Чернігівська область',
  krym: 'Автономна Республіка Крим',
};

type Point = [number, number];
interface Member { role?: string; geometry?: { lat: number; lon: number }[] }
interface Relation { tags?: Record<string, string>; members?: Member[] }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function overpass(query: string, label: string): Promise<Relation[]> {
  let lastError = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const endpoint = ENDPOINTS[attempt % ENDPOINTS.length]!;
    try {
      const response = await fetch(endpoint, {
        method: 'POST', body: query,
        signal: AbortSignal.timeout(300_000),
        headers: { 'content-type': 'text/plain', 'user-agent': 'horizont-alert/0.1 raions' },
      });
      if (response.ok) {
        const body = (await response.json()) as { elements?: Relation[] };
        if (body.elements && body.elements.length > 0) return body.elements;
        lastError = 'empty result';
      } else {
        lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    const backoff = 8_000 * 2 ** attempt;
    logger.warn({ label, attempt: attempt + 1, reason: lastError, backoff }, 'raion retry');
    await sleep(backoff);
  }
  logger.warn({ label, reason: lastError }, 'giving up on this oblast for now');
  return [];
}

function assembleRings(members: Member[]): Point[][] {
  const ways = members
    .filter((m) => (m.role ?? 'outer') === 'outer' && (m.geometry?.length ?? 0) > 1)
    .map((m) => m.geometry!.map((p) => [p.lon, p.lat] as Point));

  const rings: Point[][] = [];
  const used = new Set<number>();
  const same = (a: Point, b: Point) => Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7;

  for (let seed = 0; seed < ways.length; seed++) {
    if (used.has(seed)) continue;
    used.add(seed);
    const ring: Point[] = [...ways[seed]!];
    let extended = true;
    while (extended) {
      extended = false;
      const tail = ring.at(-1)!;
      for (let i = 0; i < ways.length; i++) {
        if (used.has(i)) continue;
        const way = ways[i]!;
        if (same(tail, way[0]!)) ring.push(...way.slice(1));
        else if (same(tail, way.at(-1)!)) ring.push(...[...way].reverse().slice(1));
        else continue;
        used.add(i);
        extended = true;
        break;
      }
    }
    if (ring.length > 3) {
      if (!same(ring[0]!, ring.at(-1)!)) ring.push(ring[0]!);
      rings.push(ring);
    }
  }
  return rings;
}

function perpendicular(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function simplify(points: Point[], tolerance: number): Point[] {
  if (points.length <= 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let worst = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = perpendicular(points[i]!, points[first]!, points[last]!);
      if (d > worst) { worst = d; index = i; }
    }
    if (index > 0 && worst > tolerance) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

function save(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data), 'utf8');
}

function loadCache(): Record<string, Relation[]> {
  if (process.env['FRESH'] === '1' || !existsSync(CACHE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as Record<string, Relation[]>;
  } catch {
    return {};
  }
}

/** Raions are smaller than oblasts, so they need a finer tolerance to keep their shape. */
const TOLERANCE = Number.parseFloat(process.env['TOLERANCE'] ?? '0.006');

async function main(): Promise<void> {
  const cache = loadCache();
  const features: unknown[] = [];
  const missing: string[] = [];

  function addOblast(oblastKey: string, relations: Relation[]): number {
    let added = 0;
    for (const relation of relations) {
      const name = relation.tags?.['name'];
      if (!name || !relation.members) continue;

      const rings = assembleRings(relation.members)
        .map((ring) => simplify(ring, TOLERANCE))
        .filter((ring) => ring.length > 3);
      if (rings.length === 0) continue;

      features.push({
        type: 'Feature',
        properties: {
          oblast: oblastKey,
          name,
          // The report names raions without the word "район"; this is the join key.
          match: normalise(name.replace(/\s*район\s*$/iu, '')),
        },
        geometry: { type: 'MultiPolygon', coordinates: rings.map((r) => [r]) },
      });
      added++;
    }
    save(OUTPUT_PATH, { type: 'FeatureCollection', features });
    return added;
  }

  // Cached oblasts first, so partial coverage reaches the map straight away.
  for (const [key, name] of Object.entries(OBLAST_NAMES)) {
    const cached = cache[key];
    if (!cached) { missing.push(key); continue; }
    logger.info({ key, raions: addOblast(key, cached), total: features.length }, 'raions from cache');
    void name;
  }
  logger.info({ ready: features.length, toFetch: missing.length }, 'cached raions written');

  for (const key of [...missing]) {
    const query = `[out:json][timeout:300];
area["name"="${OBLAST_NAMES[key]}"]["admin_level"="4"]->.o;
relation["admin_level"="6"]["boundary"="administrative"](area.o);
out geom;`;
    const relations = await overpass(query, key);
    if (relations.length === 0) continue;

    cache[key] = relations;
    save(CACHE_PATH, cache);
    logger.info({ key, raions: addOblast(key, relations), total: features.length }, 'raions fetched');
    missing.splice(missing.indexOf(key), 1);
    await sleep(3_000);
  }

  if (missing.length > 0) logger.warn({ missing }, 're-run `npm run build:raions` to fill these in');
  logger.info(
    { raions: features.length, kb: Math.round(readFileSync(OUTPUT_PATH).length / 1024) },
    'raions written',
  );
}

void main();
