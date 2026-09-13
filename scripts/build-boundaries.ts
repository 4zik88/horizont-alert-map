/**
 * Builds simplified oblast boundary polygons for the map.
 *
 *   npm run build:boundaries
 *
 * alerts.in.ua reports *which* oblasts are under alert but ships no geometry, so the
 * shapes come from OpenStreetMap. Raw OSM boundaries are far too heavy for a phone —
 * one oblast alone is ~1 MB and 18k points — so each ring is reduced with
 * Douglas-Peucker until the whole country fits in a couple of hundred kilobytes.
 *
 * Resumable: every fetched oblast is cached, so a rate limit costs time, not progress.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../src/logger.js';

const ENDPOINTS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
];

const CACHE_PATH = 'data/.boundaries-cache.json';
const OUTPUT_PATH = 'public/data/oblasts.geojson';

/** Oblast key -> the exact OSM name of its admin_level=4 relation. */
const OSM_NAMES: Record<string, string> = {
  vinnytska: 'Вінницька область',
  volynska: 'Волинська область',
  dnipropetrovska: 'Дніпропетровська область',
  donetska: 'Донецька область',
  zhytomyrska: 'Житомирська область',
  zakarpatska: 'Закарпатська область',
  zaporizka: 'Запорізька область',
  'ivano-frankivska': 'Івано-Франківська область',
  kyivska: 'Київська область',
  kirovohradska: 'Кіровоградська область',
  luhanska: 'Луганська область',
  lvivska: 'Львівська область',
  mykolaivska: 'Миколаївська область',
  odeska: 'Одеська область',
  poltavska: 'Полтавська область',
  rivnenska: 'Рівненська область',
  sumska: 'Сумська область',
  ternopilska: 'Тернопільська область',
  kharkivska: 'Харківська область',
  khersonska: 'Херсонська область',
  khmelnytska: 'Хмельницька область',
  cherkaska: 'Черкаська область',
  chernivetska: 'Чернівецька область',
  chernihivska: 'Чернігівська область',
  kyiv: 'Київ',
  krym: 'Автономна Республіка Крим',
};

type Point = [number, number]; // [lon, lat], GeoJSON order

interface Member {
  role?: string;
  geometry?: { lat: number; lon: number }[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function overpass(query: string, label: string): Promise<Member[]> {
  let lastError = '';

  for (let attempt = 0; attempt < 5; attempt++) {
    const endpoint = ENDPOINTS[attempt % ENDPOINTS.length]!;
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        body: query,
        signal: AbortSignal.timeout(300_000),
        headers: { 'content-type': 'text/plain', 'user-agent': 'horizont-alert/0.1 boundaries' },
      });

      if (response.ok) {
        const body = (await response.json()) as { elements?: { members?: Member[] }[] };
        const members = body.elements?.[0]?.members;
        if (members && members.length > 0) return members;
        lastError = 'empty result';
      } else {
        lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    const backoff = 8_000 * 2 ** attempt;
    logger.warn({ label, attempt: attempt + 1, reason: lastError, backoff }, 'boundary retry');
    await sleep(backoff);
  }

  // Skipped, not fatal: one oblast that keeps timing out must not throw away the
  // 20 already fetched. Re-running picks up the cache and retries only the gaps.
  logger.warn({ label, reason: lastError }, 'giving up on this oblast for now');
  return [];
}

/**
 * Stitch a relation's outer ways into closed rings.
 *
 * OSM stores a boundary as unordered way fragments that share endpoints; they only
 * become a fillable polygon once chained head-to-tail. Some oblasts are genuinely
 * multi-ring (islands, exclaves), so this keeps going until every way is consumed.
 */
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

        if (same(tail, way[0]!)) {
          ring.push(...way.slice(1));
        } else if (same(tail, way.at(-1)!)) {
          ring.push(...[...way].reverse().slice(1));
        } else {
          continue;
        }

        used.add(i);
        extended = true;
        break;
      }
    }

    // Close the ring and drop fragments too small to be a real area.
    if (ring.length > 3) {
      if (!same(ring[0]!, ring.at(-1)!)) ring.push(ring[0]!);
      rings.push(ring);
    }
  }

  return rings;
}

/** Perpendicular distance from a point to the segment ab, in degrees. */
function perpendicular(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);

  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Douglas-Peucker, iterative so a 18k-point ring cannot blow the stack. */
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
      const distance = perpendicular(points[i]!, points[first]!, points[last]!);
      if (distance > worst) {
        worst = distance;
        index = i;
      }
    }

    if (index > 0 && worst > tolerance) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  return points.filter((_, i) => keep[i] === 1);
}

function loadCache(): Record<string, Member[]> {
  if (process.env['FRESH'] === '1' || !existsSync(CACHE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as Record<string, Member[]>;
  } catch {
    return {};
  }
}

function save(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data), 'utf8');
}

// ~0.01 degrees is roughly 1 km — invisible at the zoom levels this map uses, and it
// cuts the payload by well over an order of magnitude.
const TOLERANCE = Number.parseFloat(process.env['TOLERANCE'] ?? '0.01');

async function main(): Promise<void> {
  const cache = loadCache();
  const features: unknown[] = [];
  const missing: string[] = [];
  let rawPoints = 0;
  let keptPoints = 0;

  function addFeature(key: string, name: string, members: Member[]): boolean {
    const rings = assembleRings(members);
    const simplified = rings
      .map((ring) => {
        rawPoints += ring.length;
        const reduced = simplify(ring, TOLERANCE);
        keptPoints += reduced.length;
        return reduced;
      })
      .filter((ring) => ring.length > 3);

    if (simplified.length === 0) {
      logger.warn({ key }, 'no usable rings — skipping');
      return false;
    }

    features.push({
      type: 'Feature',
      properties: { key, name },
      geometry: {
        // Each ring becomes its own polygon: holes are not modelled, which is right
        // for painting "this region is under alert".
        type: 'MultiPolygon',
        coordinates: simplified.map((ring) => [ring]),
      },
    });

    // Written after every oblast: the full run takes many minutes against a
    // rate-limited endpoint, and until the file exists the map shows no alert areas
    // at all. Partial coverage is immediately useful.
    save(OUTPUT_PATH, { type: 'FeatureCollection', features });
    return true;
  }

  /*
   * Cached regions are emitted first, before any network call.
   *
   * Processing in a fixed order meant one uncached oblast stalled every cached one
   * behind it — the map sat with four regions while eighteen were already on disk.
   */
  for (const [key, name] of Object.entries(OSM_NAMES)) {
    const cached = cache[key];
    if (!cached) {
      missing.push(key);
      continue;
    }
    if (addFeature(key, name, cached)) {
      logger.info({ key, total: features.length }, 'boundary from cache');
    }
  }

  logger.info({ ready: features.length, toFetch: missing.length }, 'cached boundaries written');

  for (const key of [...missing]) {
    const name = OSM_NAMES[key]!;
    const query = `[out:json][timeout:300];
relation["admin_level"="4"]["boundary"="administrative"]["name"="${name}"];
out geom;`;
    const members = await overpass(query, key);
    if (members.length === 0) continue;

    cache[key] = members;
    save(CACHE_PATH, cache);
    if (addFeature(key, name, members)) {
      logger.info({ key, total: features.length }, 'boundary fetched');
      missing.splice(missing.indexOf(key), 1);
    }
    await sleep(3_000);
  }

  if (missing.length > 0) {
    logger.warn({ missing }, 're-run `npm run build:boundaries` to fill these in');
  }

  const bytes = readFileSync(OUTPUT_PATH).length;
  logger.info(
    { oblasts: features.length, rawPoints, keptPoints, kb: Math.round(bytes / 1024) },
    'boundaries written',
  );
}

void main();
