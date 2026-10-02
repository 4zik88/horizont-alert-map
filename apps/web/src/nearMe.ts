import type { Track } from '@horizont/contract';
import { approach, distanceKm } from '@horizont/geo';
import { etaMinutes, km, typeWithCount } from './format.js';
import { isTrackStale, motionOf } from './targets.js';

/** The radius the bot uses too. */
export const NEAR_RADIUS_KM = 40;
/**
 * Beyond this a dead-reckoned ETA is not worth showing: a straight line over an hour
 * of flight says nothing about where a drone or missile actually goes.
 */
export const NEAR_MAX_ETA_MIN = 60;

export interface LatLon {
  lat: number;
  lon: number;
}

export type NearItem =
  | { kind: 'approach'; trackId: number; etaMin: number; closestKm: number; text: string }
  | { kind: 'destination'; trackId: number; distanceKm: number; text: string };

/**
 * Targets that concern the user, computed on the device only.
 *
 * - A reported position with a heading and a typical speed: the projected path passes
 *   within 40 km -> "~N хв до вас (орієнтовно), пройде за ~K км".
 * - A reported destination within 40 km: named, with a distance and NO time, because
 *   the target is not there and its arrival is not something we can know.
 */
export function nearMe(tracks: Track[], me: LatLon, now: number): NearItem[] {
  const approaching: NearItem[] = [];
  const heading: NearItem[] = [];
  for (const t of tracks) {
    if (isTrackStale(t, now)) continue;
    // "somewhere in Chernihiv oblast" has no distance or time to anyone.
    if (t.last.area) continue;
    const label = typeWithCount(t.type, t.count);
    if (t.last.kind === 'position') {
      if (t.type === 'ballistic') continue;
      const a = approach(motionOf(t), me, now);
      if (!a || a.closestKm > NEAR_RADIUS_KM || a.etaMin > NEAR_MAX_ETA_MIN) continue;
      approaching.push({
        kind: 'approach',
        trackId: t.id,
        etaMin: a.etaMin,
        closestKm: a.closestKm,
        text: `${label} · ~${etaMinutes(a.etaMin)} хв до вас (орієнтовно), пройде за ${a.closestKm < 1 ? '<1' : `~${km(a.closestKm)}`} км`,
      });
    } else if (t.last.kind === 'destination') {
      const d = distanceKm(me.lat, me.lon, t.last.lat, t.last.lon);
      if (d > NEAR_RADIUS_KM) continue;
      const place = t.last.placeName ?? 'невідомий пункт';
      heading.push({
        kind: 'destination',
        trackId: t.id,
        distanceKm: d,
        text: `${label} курс на ${place} (${km(d)} км від вас)`,
      });
    }
  }
  approaching.sort((a, b) => (a.kind === 'approach' && b.kind === 'approach' ? a.etaMin - b.etaMin : 0));
  heading.sort((a, b) =>
    a.kind === 'destination' && b.kind === 'destination' ? a.distanceKm - b.distanceKm : 0,
  );
  return [...approaching, ...heading];
}
