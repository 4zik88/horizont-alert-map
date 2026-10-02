import {
  FORECAST_SPEED_KMH,
  STALE_AFTER_MS,
  TRACK_TAIL_MS,
  type Track,
} from '@horizont/contract';
import { bearing, forecast, type ForecastPoint, type Motion } from '@horizont/geo';

/**
 * Pure presentation model for one track: what the marker means, whether it may be
 * projected, and how its tail fades. The map module only turns this into pixels.
 */

export function isTrackStale(t: Pick<Track, 'lastSeenAt'>, now: number): boolean {
  return now - t.lastSeenAt > STALE_AFTER_MS;
}

/** The motion the forecast works from. Speed is the type's typical speed, never measured. */
export function motionOf(t: Track): Motion {
  return {
    lat: t.last.lat,
    lon: t.last.lon,
    headingDeg: t.last.headingDeg,
    speedKmh: FORECAST_SPEED_KMH[t.type],
    observedAt: t.lastSeenAt,
  };
}

/**
 * 10/20/30-minute points, or nothing. Only a reported *position* can be projected:
 * a destination is where it might go, a launch site is where it started.
 */
export function trackForecast(t: Track, now: number): ForecastPoint[] {
  if (t.last.kind !== 'position') return [];
  // A whole oblast resolved to its centre is not a point to project from.
  if (t.last.area) return [];
  if (t.type === 'ballistic') return [];
  if (isTrackStale(t, now)) return [];
  if (t.last.headingDeg === null || FORECAST_SPEED_KMH[t.type] === null) return [];
  return forecast(motionOf(t), now);
}

export type MarkerStyle = 'filled' | 'hollow' | 'launch';

export interface MarkerModel {
  style: MarkerStyle;
  stale: boolean;
  /** Rotation for the icon, or null: drawn upright with a dashed ring. */
  rotation: number | null;
  /**
   * Destination markers are drawn beside the town, on the side the target comes
   * from: the compass bearing (from the town) to put the icon at. Null otherwise.
   */
  offsetBearing: number | null;
  /** Icon size in px; grows with the count. */
  size: number;
}

export function markerSize(count: number): number {
  if (count <= 1) return 30;
  return Math.round(Math.min(48, 30 + Math.log2(count) * 6));
}

/** Where a destination-only target is coming from, if anything says so. */
export function comingFromBearing(t: Track): number | null {
  if (t.last.headingDeg !== null) return (t.last.headingDeg + 180) % 360;
  // An earlier reported point that is not the destination itself.
  for (let i = t.path.length - 1; i >= 0; i--) {
    const p = t.path[i]!;
    if (p.kind === 'launch' || p.kind === 'position') {
      if (Math.abs(p.lat - t.last.lat) + Math.abs(p.lon - t.last.lon) < 1e-6) continue;
      return bearing(t.last.lat, t.last.lon, p.lat, p.lon);
    }
  }
  return null;
}

export function markerModel(t: Track, now: number): MarkerModel {
  const kind = t.last.kind;
  const stale = isTrackStale(t, now);
  const heading = t.last.headingDeg;
  return {
    style: kind === 'position' ? 'filled' : kind === 'destination' ? 'hollow' : 'launch',
    stale,
    rotation: kind === 'launch' ? null : heading,
    offsetBearing: kind === 'destination' ? comingFromBearing(t) ?? null : null,
    size: markerSize(t.count),
  };
}

/** Pixel offset for a compass bearing at a given radius (screen y grows downwards). */
export function offsetPx(bearingDeg: number, radius: number): [number, number] {
  const r = (bearingDeg * Math.PI) / 180;
  return [Math.round(Math.sin(r) * radius) + 0, Math.round(-Math.cos(r) * radius) + 0];
}

/** Opacity of a tail segment by its age: 0.9 when fresh, 0.1 at an hour old. */
export function fadeOpacity(at: number, now: number, tailMs: number = TRACK_TAIL_MS): number {
  const age = Math.max(0, now - at);
  if (age >= tailMs) return 0;
  return Math.round((0.9 - (age / tailMs) * 0.8) * 100) / 100;
}

export interface TailSegment {
  from: [number, number];
  to: [number, number];
  opacity: number;
}

/**
 * Path segments within the last hour, each faded by the age of its newer end.
 * Only places the target actually was (positions, and the launch site) are joined:
 * a "курс на X" point is not somewhere it has been, so no line is drawn to it.
 */
export function tailSegments(t: Track, now: number, tailMs: number = TRACK_TAIL_MS): TailSegment[] {
  const pts = t.path.filter(
    (p) => p.kind !== 'destination' && now - p.at <= tailMs && p.at <= now,
  );
  const out: TailSegment[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const opacity = fadeOpacity(b.at, now, tailMs);
    if (opacity > 0) out.push({ from: [a.lon, a.lat], to: [b.lon, b.lat], opacity });
  }
  return out;
}
