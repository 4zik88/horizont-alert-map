import type { Alert, Observation, Track } from '@horizont/contract';

export const NOW = Date.UTC(2026, 9, 2, 18, 0); // 21:00 in Kyiv
export const MIN = 60_000;

export function obs(over: Partial<Observation> = {}): Observation {
  return {
    id: 1, trackId: 1, type: 'uav', count: 1, relation: 'over', kind: 'position', area: false,
    lat: 49.66, lon: 30.98, placeName: 'Миронівка', fromName: null, headingDeg: 0,
    speedKmh: null, confidence: 0.8, source: 'rules', observedAt: NOW - 2 * MIN,
    channel: 'kpszsu', messageId: 100, ...over,
  };
}

export function track(over: Partial<Track> = {}, last: Partial<Observation> = {}): Track {
  const l = obs(last);
  return {
    id: 1, type: l.type, count: l.count, last: l,
    path: [{ lat: l.lat, lon: l.lon, at: l.observedAt, kind: l.kind }],
    confidence: l.confidence, firstSeenAt: l.observedAt, lastSeenAt: l.observedAt, ...over,
  };
}

export function alert(over: Partial<Alert> = {}): Alert {
  return {
    id: 1, regionId: 'oblast:kyivska', oblast: 'kyivska', level: 'oblast', severity: 'full',
    areas: [], startedAt: NOW - 10 * MIN, endedAt: null, ...over,
  };
}
