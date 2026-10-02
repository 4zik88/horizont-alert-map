import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Which raion a point is in.
 *
 * Alerts are declared per raion, and a raion is roughly an hour's drive across — so
 * "Повітряна тривога — Вінницька обл." told a reader in Kozyatyn that something was
 * happening somewhere in an area the size of a small country, most of which was
 * nowhere near them. Warning on their own raion is the whole point of holding their
 * coordinates at all.
 *
 * Point-in-polygon rather than the nearest settlement: an oblast can be guessed from
 * the nearest town and still be right, but raion borders are close enough together
 * that the nearest town is regularly in the next one along.
 */

export interface Raion {
  /** Oblast key, matching the parser's `oblasts.ts`. */
  oblast: string;
  /** Display name, e.g. "Козятинський район". */
  name: string;
  /** Normalised key the alert feed's area names are reduced to. */
  match: string;
}

interface Indexed extends Raion {
  /** Bounding box, so the ray cast runs on a handful of candidates, not all 161. */
  box: [number, number, number, number]; // minLat, minLon, maxLat, maxLon
  /** Outer rings only; holes do not occur in this dataset and enclaves do not exist. */
  rings: [number, number][][]; // [lon, lat]
}

const HERE = dirname(fileURLToPath(import.meta.url));

/*
 * Resolved from this module rather than the working directory: the service is started
 * as `node dist/index.js` from an image whose cwd is not guaranteed, and a relative
 * path silently yielded an empty table rather than an error.
 */
function dataPath(): string {
  // src/ and dist/ both sit one level below the package root, next to data/.
  return resolve(join(HERE, '..', 'data', 'raions.geojson'));
}

/**
 * Where load problems go. The package has no logger of its own; the worker plugs its
 * pino instance in at boot. A missing file must still be loud somewhere.
 */
export interface RaionLog {
  info(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

let log: RaionLog = {
  info: () => {},
  error: (fields, message) => console.error(message, fields),
};

export function setRaionLogger(next: RaionLog): void {
  log = next;
}

let cache: Indexed[] | undefined;

function load(): Indexed[] {
  if (cache) return cache;

  try {
    const raw = JSON.parse(readFileSync(dataPath(), 'utf8')) as {
      features: {
        properties: Raion;
        geometry: { type: string; coordinates: unknown };
      }[];
    };

    cache = raw.features.flatMap((feature) => {
      const rings = outerRings(feature.geometry);
      if (rings.length === 0) return [];

      let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
      for (const ring of rings) {
        for (const [lon, lat] of ring) {
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
          if (lon < minLon) minLon = lon;
          if (lon > maxLon) maxLon = lon;
        }
      }

      return [{
        ...feature.properties,
        box: [minLat, minLon, maxLat, maxLon] as [number, number, number, number],
        rings,
      }];
    });

    log.info({ raions: cache.length }, 'raion polygons loaded');
  } catch (error) {
    /*
     * A missing or broken file must not take the service down. Every caller treats
     * "unknown raion" as a reason to fall back to the oblast, which is the behaviour
     * this replaced — degraded, not broken.
     */
    log.error(
      { err: error instanceof Error ? error.message : String(error) },
      'raion polygons unavailable; alerts fall back to oblast level',
    );
    cache = [];
  }

  return cache;
}

/** Polygon and MultiPolygon flattened to a list of outer rings. */
function outerRings(geometry: { type: string; coordinates: unknown }): [number, number][][] {
  if (geometry.type === 'Polygon') {
    return [(geometry.coordinates as [number, number][][])[0]!];
  }
  if (geometry.type === 'MultiPolygon') {
    return (geometry.coordinates as [number, number][][][]).map((poly) => poly[0]!);
  }
  return [];
}

/** Standard even-odd ray cast. Points exactly on an edge are not worth special care. */
function inRing(lat: number, lon: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** The raion containing this point, or undefined outside every polygon. */
export function raionAt(lat: number, lon: number): Raion | undefined {
  for (const raion of load()) {
    const [minLat, minLon, maxLat, maxLon] = raion.box;
    if (lat < minLat || lat > maxLat || lon < minLon || lon > maxLon) continue;
    if (raion.rings.some((ring) => inRing(lat, lon, ring))) {
      return { oblast: raion.oblast, name: raion.name, match: raion.match };
    }
  }
  return undefined;
}

/** Every raion of an oblast, used to tell an oblast-wide alert from a local one. */
export function raionsOf(oblast: string): Raion[] {
  return load()
    .filter((r) => r.oblast === oblast)
    .map((r) => ({ oblast: r.oblast, name: r.name, match: r.match }));
}

/** The raion with this normalised key, for turning a stored key back into words. */
export function raionByMatch(match: string): Raion | undefined {
  const hit = load().find((r) => r.match === match);
  return hit && { oblast: hit.oblast, name: hit.name, match: hit.match };
}

/**
 * A raion key as a reader would see it — "Хмільницький район".
 *
 * Falls back to the key itself rather than an empty string: a name we cannot resolve
 * is still more use to someone than a blank where a place should be.
 */
export function raionName(match: string): string {
  return raionByMatch(match)?.name ?? match;
}
