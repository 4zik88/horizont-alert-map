import { distanceKm } from '../parser/rules.js';
import { TYPE_SPEED_KMH, type TargetType } from '../parser/targetTypes.js';

/**
 * Decides whether a target concerns a given user.
 *
 * This is what makes someone's phone buzz at 03:00, so it is pure and heavily
 * tested. Two independent reasons to warn, per the spec:
 *
 *  1. The target is inside the user's radius.
 *  2. The target's course points at the user — worth knowing *before* it arrives,
 *     which is the whole value of the tool.
 *
 * False alarms are the real risk: for a group of ten people, a bot that cries wolf
 * gets muted, and then it is worse than useless. Hence the confidence floor, the
 * staleness cut-off, and a deliberately narrow course corridor.
 */

export interface TargetView {
  id: number;
  type: TargetType;
  toName: string | null;
  toLat: number | null;
  toLon: number | null;
  fromLat: number | null;
  fromLon: number | null;
  courseDeg: number | null;
  confidence: number;
  observedAt: number;
}

export interface UserView {
  chatId: number;
  lat: number;
  lon: number;
  radiusKm: number;
}

export interface ProximityOptions {
  /** Ignore targets below this confidence; a guessed location must not alert anyone. */
  minConfidence: number;
  /** Ignore targets older than this — an hour-old sighting is not actionable. */
  maxAgeMs: number;
  /** Half-width of the course corridor, in degrees. */
  courseToleranceDeg: number;
  /** How far ahead along the course to look, as minutes of flight for that type. */
  leadMinutes: number;
  now: number;
}

export const DEFAULT_PROXIMITY: Omit<ProximityOptions, 'now'> = {
  minConfidence: 0.6,
  maxAgeMs: 30 * 60_000,
  courseToleranceDeg: 30,
  leadMinutes: 25,
};

export type MatchReason = 'in_radius' | 'heading_towards';

export interface Match {
  reason: MatchReason;
  /** Distance from the user to the target's reported position, km. */
  distanceKm: number;
}

/** Smallest absolute angle between two bearings, 0-180. */
export function angleDelta(a: number, b: number): number {
  const diff = Math.abs(((a - b) % 360 + 360) % 360);
  return diff > 180 ? 360 - diff : diff;
}

/** Where the target actually is: its origin when known, otherwise its destination. */
function positionOf(target: TargetView): { lat: number; lon: number } | undefined {
  if (target.fromLat !== null && target.fromLon !== null) {
    return { lat: target.fromLat, lon: target.fromLon };
  }
  if (target.toLat !== null && target.toLon !== null) {
    return { lat: target.toLat, lon: target.toLon };
  }
  return undefined;
}

export function matchTarget(
  target: TargetView,
  user: UserView,
  opts: ProximityOptions,
): Match | undefined {
  if (target.confidence < opts.minConfidence) return undefined;
  if (opts.now - target.observedAt > opts.maxAgeMs) return undefined;

  const position = positionOf(target);
  if (!position) return undefined;

  // Closest of the two known points: a target heading for a town 5 km away concerns
  // the user even if it is currently 200 km out.
  const distances: number[] = [distanceKm(user.lat, user.lon, position.lat, position.lon)];
  if (target.toLat !== null && target.toLon !== null) {
    distances.push(distanceKm(user.lat, user.lon, target.toLat, target.toLon));
  }
  const nearest = Math.min(...distances);

  if (nearest <= user.radiusKm) {
    return { reason: 'in_radius', distanceKm: nearest };
  }

  // Course corridor. Only meaningful with a known heading and a known origin —
  // without an origin the "course" is a guess about where it came from.
  if (target.courseDeg === null || target.fromLat === null || target.fromLon === null) {
    return undefined;
  }

  const bearingToUser = bearingBetween(position.lat, position.lon, user.lat, user.lon);
  if (angleDelta(bearingToUser, target.courseDeg) > opts.courseToleranceDeg) return undefined;

  // Only warn about what can plausibly reach them soon. A drone 600 km up-track is
  // not news; the same drone 20 minutes out is.
  const reach = (TYPE_SPEED_KMH[target.type] * opts.leadMinutes) / 60;
  const fromPosition = distanceKm(user.lat, user.lon, position.lat, position.lon);
  if (fromPosition > reach + user.radiusKm) return undefined;

  return { reason: 'heading_towards', distanceKm: fromPosition };
}

/** Initial great-circle bearing, degrees, 0 = north. Local copy to keep this pure. */
function bearingBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const f1 = lat1 * toRad;
  const f2 = lat2 * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const y = Math.sin(dLon) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dLon);
  return (Math.atan2(y, x) / toRad + 360) % 360;
}
