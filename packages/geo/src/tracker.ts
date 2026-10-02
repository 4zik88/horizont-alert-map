import { angleDiff, bearing, distanceKm } from './sphere.js';

/**
 * Joining consecutive sightings of one group into a track.
 *
 * Three channels report the same drone in their own words, and each keeps reporting
 * it as it moves. Without joining, the map shows a cloud of separate markers for one
 * group and no path at all. Joining wrongly is worse — it draws a flight that never
 * happened — so every rule here errs toward starting a new track.
 *
 * Coordinates are the one point each message gives, which for a "курсом на X" report
 * is the destination, not the target. The distance gate therefore carries a fixed
 * slack on top of speed × time, and the heading check is skipped for short hops.
 */

export type SightingKind = 'position' | 'destination' | 'launch';

export interface OpenTrack {
  id: number;
  type: string;
  lat: number;
  lon: number;
  lastKind: SightingKind;
  lastSeenAt: number;
  headingDeg: number | null;
}

export interface Sighting {
  type: string;
  lat: number;
  lon: number;
  kind: SightingKind;
  headingDeg: number | null;
  observedAt: number;
}

export interface LinkOptions {
  /** Typical speed by type, km/h. Every type needs a number here. */
  speedKmh: (type: string) => number;
  /** A track this long without a sighting is closed. */
  maxGapMs: number;
  /** Fixed allowance for gazetteer imprecision and destination-only points, km. */
  slackKm: number;
  /** Stretch on speed × time, for reports that lag the target. */
  speedFactor: number;
  /** Largest disagreement between a track's heading and the hop that extends it. */
  maxTurnDeg: number;
  /** Hops shorter than this skip the heading check: the points are too close to aim. */
  aimMinKm: number;
  /** Reports can arrive slightly out of order; accept a sighting this much older. */
  reorderMs: number;
}

export const DEFAULT_LINK: Omit<LinkOptions, 'speedKmh'> = {
  maxGapMs: 25 * 60_000,
  slackKm: 30,
  speedFactor: 1.5,
  maxTurnDeg: 60,
  aimMinKm: 15,
  reorderMs: 5 * 60_000,
};

/** The open track this sighting continues, or null to start a new one. */
export function linkSighting(
  open: readonly OpenTrack[],
  s: Sighting,
  opts: LinkOptions,
): number | null {
  let best: { id: number; score: number } | null = null;

  for (const t of open) {
    if (t.type !== s.type) continue;
    // A launch site only ever merges with a repeat report of the same launch; a
    // position never continues from a launch site, which would draw a path out of
    // Russia that no message described.
    if ((t.lastKind === 'launch') !== (s.kind === 'launch')) continue;

    const dt = s.observedAt - t.lastSeenAt;
    if (dt > opts.maxGapMs || dt < -opts.reorderMs) continue;

    const d = distanceKm(t.lat, t.lon, s.lat, s.lon);
    if (s.kind === 'launch') {
      if (d > 5) continue;
    } else {
      const allowed = opts.speedKmh(s.type) * (Math.max(dt, 0) / 3_600_000) * opts.speedFactor + opts.slackKm;
      if (d > allowed) continue;

      if (d >= opts.aimMinKm && t.headingDeg !== null) {
        if (angleDiff(bearing(t.lat, t.lon, s.lat, s.lon), t.headingDeg) > opts.maxTurnDeg) continue;
      }
      if (t.headingDeg !== null && s.headingDeg !== null) {
        if (angleDiff(t.headingDeg, s.headingDeg) > opts.maxTurnDeg) continue;
      }
    }

    // Prefer the closest in space, then in time.
    const score = d + Math.abs(dt) / 60_000;
    if (!best || score < best.score) best = { id: t.id, score };
  }

  return best?.id ?? null;
}

/**
 * The heading a track carries after a sighting joins it: the one the message states,
 * else the direction of travel between two reported positions, else the old one.
 */
export function nextHeading(t: OpenTrack, s: Sighting, aimMinKm = DEFAULT_LINK.aimMinKm): number | null {
  if (s.headingDeg !== null) return s.headingDeg;
  if (t.lastKind === 'position' && s.kind === 'position') {
    if (distanceKm(t.lat, t.lon, s.lat, s.lon) >= aimMinKm) return bearing(t.lat, t.lon, s.lat, s.lon);
  }
  return t.headingDeg;
}
