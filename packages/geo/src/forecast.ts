import { destination } from './sphere.js';

/**
 * Dead reckoning from a single reported position.
 *
 * Every number here is an estimate built on two guesses: the heading the channel wrote
 * and the *typical* speed of the target type. Nothing is measured. Callers must label
 * the output as approximate, and nothing here is produced once a report is stale.
 */

/** After this long without a new report, a target is drawn grey and never projected. */
export const STALE_AFTER_MIN = 25;

/** Forecast horizons drawn on the map. */
export const FORECAST_MINUTES = [10, 20, 30] as const;

export interface Motion {
  lat: number;
  lon: number;
  /** Null when no direction is known. No direction means no forecast. */
  headingDeg: number | null;
  /** Typical speed for the type. Null for ballistic: no trajectory is ever drawn. */
  speedKmh: number | null;
  /** Epoch ms of the report. */
  observedAt: number;
}

export function isStale(motion: Pick<Motion, 'observedAt'>, now: number): boolean {
  return now - motion.observedAt > STALE_AFTER_MIN * 60_000;
}

function projectable(motion: Motion, now: number): motion is Motion & {
  headingDeg: number;
  speedKmh: number;
} {
  return (
    motion.headingDeg !== null &&
    motion.speedKmh !== null &&
    motion.speedKmh > 0 &&
    !isStale(motion, now)
  );
}

export interface ForecastPoint {
  /** Minutes after the report, not after now. */
  minutes: number;
  lat: number;
  lon: number;
}

/**
 * Positions 10/20/30 minutes after the report, along the stated heading.
 * Empty when the target is stale, has no heading, or has no speed.
 */
export function forecast(
  motion: Motion,
  now: number,
  minutes: readonly number[] = FORECAST_MINUTES,
): ForecastPoint[] {
  if (!projectable(motion, now)) return [];
  return minutes.map((m) => ({
    minutes: m,
    ...destination(motion.lat, motion.lon, motion.headingDeg, (motion.speedKmh * m) / 60),
  }));
}

export interface Approach {
  /** Distance between the user and the projected path at its closest point. */
  closestKm: number;
  /** Minutes from `now` until the closest point. Never negative. */
  etaMin: number;
}

/**
 * How close the projected path passes to a point, and when.
 *
 * Works on a flat projection centred on the point, which is exact enough within a few
 * hundred km. Undefined when there is nothing to project or the closest point is
 * already behind the target, because a target moving away is not approaching anyone.
 */
export function approach(
  motion: Motion,
  point: { lat: number; lon: number },
  now: number,
): Approach | undefined {
  if (!projectable(motion, now)) return undefined;

  const kx = 111.32 * Math.cos((point.lat * Math.PI) / 180);
  const ky = 110.57;
  // Vector from the point to the target's reported position, in km.
  const px = (motion.lon - point.lon) * kx;
  const py = (motion.lat - point.lat) * ky;

  const h = (motion.headingDeg * Math.PI) / 180;
  const dx = Math.sin(h);
  const dy = Math.cos(h);

  // Distance along the heading from the report to the closest point.
  const along = -(px * dx + py * dy);
  const closestKm = Math.abs(px * dy - py * dx);

  const elapsedMin = (now - motion.observedAt) / 60_000;
  const etaMin = (along / motion.speedKmh) * 60 - elapsedMin;
  if (etaMin < 0) return undefined;

  return { closestKm, etaMin };
}

export interface ConcernRule {
  radiusKm: number;
  maxEtaMin: number;
}

/** The brief's rule: the path passes within 40 km, and gets there within 30 minutes. */
export const DEFAULT_CONCERN: ConcernRule = { radiusKm: 40, maxEtaMin: 30 };

export function concerns(a: Approach | undefined, rule: ConcernRule = DEFAULT_CONCERN): boolean {
  return a !== undefined && a.closestKm <= rule.radiusKm && a.etaMin <= rule.maxEtaMin;
}
