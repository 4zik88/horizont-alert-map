import type { Alert, Track } from '@horizont/contract';

/** Minimal GeoJSON shapes; we only need polygons. */
export type Ring = [number, number][];
export type PolygonCoords = Ring[];
export interface RegionGeometry {
  type: 'Polygon' | 'MultiPolygon';
  coordinates: PolygonCoords | PolygonCoords[];
}
export interface RegionProps {
  id: string;
  kind: 'oblast' | 'raion';
  oblast: string;
  name?: string;
}
export interface RegionFeature {
  type: 'Feature';
  properties: RegionProps;
  geometry: RegionGeometry;
}
export interface RegionCollection {
  type: 'FeatureCollection';
  features: RegionFeature[];
}

/** 0 = no alert, 1 = partial (yellow), 2 = full (red). Used as MapLibre feature-state. */
export type AlertLevel = 0 | 1 | 2;

export interface RegionAlertState {
  level: AlertLevel;
  alerts: Alert[];
}

/**
 * Which polygon gets which colour.
 *
 * - raion alert (regionId is a raion) -> that raion red;
 * - oblast-level full alert -> the whole oblast red;
 * - hromada-level (or any partial oblast) alert -> the oblast yellow; the hromadas
 *   have no polygon, so the tooltip lists them instead.
 *
 * Red always wins over yellow on the same polygon.
 */
export function regionAlertStates(alerts: Alert[]): Map<string, RegionAlertState> {
  const out = new Map<string, RegionAlertState>();
  for (const a of alerts) {
    if (a.endedAt !== null) continue;
    const isRaion = a.regionId.startsWith('raion:');
    const level: AlertLevel = isRaion || (a.level !== 'hromada' && a.severity === 'full') ? 2 : 1;
    const prev = out.get(a.regionId);
    if (prev) {
      prev.alerts.push(a);
      if (level > prev.level) prev.level = level;
    } else {
      out.set(a.regionId, { level, alerts: [a] });
    }
  }
  return out;
}

/** Hromada / city names under alert in an oblast, deduplicated, for the tooltip. */
export function alertAreas(state: RegionAlertState | undefined): string[] {
  if (!state) return [];
  return [...new Set(state.alerts.flatMap((a) => a.areas))];
}

export function oblastOfRegionId(id: string): string | null {
  const [kind, oblast] = id.split(':');
  return (kind === 'oblast' || kind === 'raion') && oblast ? oblast : null;
}

function inRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a[1] > lat !== b[1] > lat && lon < ((b[0] - a[0]) * (lat - a[1])) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
}

function inPolygon(lon: number, lat: number, poly: PolygonCoords): boolean {
  const [outer, ...holes] = poly;
  if (!outer || !inRing(lon, lat, outer)) return false;
  return !holes.some((h) => inRing(lon, lat, h));
}

export function pointInGeometry(lon: number, lat: number, g: RegionGeometry): boolean {
  if (g.type === 'Polygon') return inPolygon(lon, lat, g.coordinates as PolygonCoords);
  return (g.coordinates as PolygonCoords[]).some((p) => inPolygon(lon, lat, p));
}

export type BBox = [number, number, number, number];

export function bbox(features: RegionFeature[]): BBox | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const f of features) {
    const polys =
      f.geometry.type === 'Polygon'
        ? [f.geometry.coordinates as PolygonCoords]
        : (f.geometry.coordinates as PolygonCoords[]);
    for (const p of polys)
      for (const [x, y] of p[0] ?? []) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
  }
  return minX === Infinity ? null : [minX, minY, maxX, maxY];
}

/** Kyiv city has no polygon of its own in the map file; it sits inside Kyiv oblast. */
export function oblastPolygonKey(oblast: string): string {
  return oblast === 'kyiv' ? 'kyivska' : oblast;
}

export function oblastFeatures(regions: RegionCollection, oblast: string): RegionFeature[] {
  const key = oblastPolygonKey(oblast);
  return regions.features.filter((f) => f.properties.kind === 'oblast' && f.properties.oblast === key);
}

/** "Тільки моя область": keep alerts of that oblast, and tracks whose marker or path is inside it. */
export function filterToOblast<T extends { alerts: Alert[]; tracks: Track[] }>(
  view: T,
  oblast: string,
  regions: RegionCollection | null,
): T {
  const key = oblastPolygonKey(oblast);
  const alerts = view.alerts.filter((a) => oblastPolygonKey(a.oblast) === key);
  const shapes = regions ? oblastFeatures(regions, oblast) : [];
  const inside = (lon: number, lat: number) => shapes.some((f) => pointInGeometry(lon, lat, f.geometry));
  const tracks =
    shapes.length === 0
      ? view.tracks
      : view.tracks.filter(
          (t) => inside(t.last.lon, t.last.lat) || t.path.some((p) => inside(p.lon, p.lat)),
        );
  return { ...view, alerts, tracks };
}
