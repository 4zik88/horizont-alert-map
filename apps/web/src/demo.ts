import type {
  Alert,
  Me,
  Observation,
  PointKind,
  Relation,
  ServerMessage,
  Snapshot,
  SourceStatus,
  TargetType,
  Track,
} from '@horizont/contract';
import { destination } from '@horizont/geo';

/**
 * Demo mode (`?demo=1`): realistic fixtures and a fake event stream, so the map can be
 * developed and screenshotted without the API. Times are relative to `now`.
 */

export const DEMO_ME: Me = { name: 'Демо', oblast: 'kyivska' };

const MIN = 60_000;

interface PathPoint {
  lat: number;
  lon: number;
  ago: number;
  kind: PointKind;
  place: string;
}

interface Spec {
  id: number;
  type: TargetType;
  count: number;
  heading: number | null;
  relation: Relation;
  confidence: number;
  channel: string;
  messageId: number;
  fromName?: string;
  /** Oldest first; the last one is the latest observation. */
  path: PathPoint[];
}

const SPECS: Spec[] = [
  {
    id: 101, type: 'uav', count: 5, heading: 335, relation: 'over', confidence: 0.86,
    channel: 'kpszsu', messageId: 41870,
    path: [
      { lat: 49.67, lon: 32.04, ago: 52, kind: 'position', place: 'Золотоноша' },
      { lat: 49.75, lon: 31.46, ago: 31, kind: 'position', place: 'Канів' },
      { lat: 49.66, lon: 30.98, ago: 4, kind: 'position', place: 'Миронівка' },
    ],
  },
  {
    id: 102, type: 'jet_uav', count: 1, heading: 290, relation: 'past', confidence: 0.74,
    channel: 'sectorv666', messageId: 9921,
    path: [
      { lat: 48.93, lon: 33.95, ago: 6, kind: 'position', place: 'Градизьк' },
      { lat: 49.07, lon: 33.42, ago: 2, kind: 'position', place: 'Кременчук' },
    ],
  },
  {
    id: 103, type: 'cruise', count: 4, heading: 285, relation: 'over', confidence: 0.81,
    channel: 'kpszsu', messageId: 41872,
    path: [
      { lat: 48.75, lon: 30.22, ago: 9, kind: 'position', place: 'Умань' },
      { lat: 49.05, lon: 28.95, ago: 2, kind: 'position', place: 'Немирів' },
    ],
  },
  {
    id: 104, type: 'ballistic', count: 1, heading: 270, relation: 'towards', confidence: 0.9,
    channel: 'kpszsu', messageId: 41873,
    path: [{ lat: 48.46, lon: 35.05, ago: 1, kind: 'position', place: 'Дніпро' }],
  },
  {
    id: 105, type: 'kab', count: 3, heading: null, relation: 'over', confidence: 0.7,
    channel: 'kozakchornobay', messageId: 15502,
    path: [{ lat: 50.15, lon: 36.3, ago: 6, kind: 'position', place: 'Дергачі' }],
  },
  {
    id: 106, type: 'aviation', count: 2, heading: null, relation: 'over', confidence: 0.6,
    channel: 'kozakchornobay', messageId: 15499,
    path: [{ lat: 47.35, lon: 35.95, ago: 12, kind: 'position', place: 'Оріхів' }],
  },
  {
    id: 107, type: 'recon', count: 1, heading: 240, relation: 'over', confidence: 0.66,
    channel: 'sectorv666', messageId: 9917,
    path: [
      { lat: 50.98, lon: 35.2, ago: 18, kind: 'position', place: 'Краснопілля' },
      { lat: 50.85, lon: 35.0, ago: 7, kind: 'position', place: 'Сумський район' },
    ],
  },
  {
    id: 108, type: 'unknown', count: 1, heading: 10, relation: 'over', confidence: 0.45,
    channel: 'kozakchornobay', messageId: 15480,
    path: [{ lat: 46.62, lon: 30.9, ago: 38, kind: 'position', place: 'Южне' }],
  },
  {
    id: 109, type: 'uav', count: 2, heading: 320, relation: 'over', confidence: 0.8,
    channel: 'kpszsu', messageId: 41850,
    path: [
      { lat: 46.75, lon: 32.4, ago: 55, kind: 'position', place: 'Кінбурнська коса' },
      { lat: 46.97, lon: 31.99, ago: 31, kind: 'position', place: 'Миколаїв' },
    ],
  },
  {
    id: 110, type: 'uav', count: 2, heading: 205, relation: 'towards', confidence: 0.77,
    channel: 'kpszsu', messageId: 41871, fromName: 'Козелець',
    path: [
      { lat: 50.91, lon: 31.12, ago: 20, kind: 'position', place: 'Козелець' },
      { lat: 50.51, lon: 30.79, ago: 5, kind: 'destination', place: 'Бровари' },
    ],
  },
  {
    id: 111, type: 'uav', count: 6, heading: null, relation: 'launch', confidence: 0.88,
    channel: 'kpszsu', messageId: 41860,
    path: [{ lat: 46.05, lon: 38.17, ago: 15, kind: 'launch', place: 'Приморсько-Ахтарськ' }],
  },
  {
    id: 112, type: 'cruise', count: 2, heading: 300, relation: 'over', confidence: 0.79,
    channel: 'kpszsu', messageId: 41790,
    path: [
      { lat: 47.91, lon: 33.39, ago: 140, kind: 'position', place: 'Кривий Ріг' },
      { lat: 48.51, lon: 32.26, ago: 132, kind: 'position', place: 'Кропивницький' },
    ],
  },
];

function buildTrack(s: Spec, now: number): Track {
  const pts = s.path;
  const last = pts[pts.length - 1]!;
  const first = pts[0]!;
  const lastAt = now - last.ago * MIN;
  const obs: Observation = {
    id: s.id * 10 + pts.length,
    trackId: s.id,
    type: s.type,
    count: s.count,
    relation: last.kind === 'launch' ? 'launch' : last.kind === 'destination' ? 'towards' : s.relation,
    kind: last.kind,
    area: false,
    lat: last.lat,
    lon: last.lon,
    placeName: last.place,
    fromName: s.fromName ?? null,
    headingDeg: s.heading,
    speedKmh: null,
    confidence: s.confidence,
    source: 'rules',
    observedAt: lastAt,
    channel: s.channel,
    messageId: s.messageId,
  };
  return {
    id: s.id,
    type: s.type,
    count: s.count,
    last: obs,
    path: pts.map((p) => ({ lat: p.lat, lon: p.lon, at: now - p.ago * MIN, kind: p.kind })),
    confidence: s.confidence,
    firstSeenAt: now - first.ago * MIN,
    lastSeenAt: lastAt,
  };
}

function alert(
  id: number,
  regionId: string,
  level: Alert['level'],
  severity: Alert['severity'],
  startedAgo: number,
  now: number,
  areas: string[] = [],
  endedAgo: number | null = null,
): Alert {
  const parts = regionId.split(':');
  return {
    id,
    regionId,
    oblast: parts[1] ?? '',
    level,
    severity,
    areas,
    startedAt: now - startedAgo * MIN,
    endedAt: endedAgo === null ? null : now - endedAgo * MIN,
  };
}

/** Every alert the demo knows, including ended ones (for the timeline). */
function demoAlerts(now: number): Alert[] {
  return [
    alert(1, 'raion:kharkivska:харківський', 'raion', 'full', 50, now),
    alert(2, 'raion:kharkivska:чугуївський', 'raion', 'full', 48, now),
    alert(3, 'raion:kharkivska:богодухівський', 'raion', 'full', 44, now),
    alert(4, 'raion:sumska:сумський', 'raion', 'full', 20, now),
    alert(5, 'oblast:dnipropetrovska', 'oblast', 'full', 3, now),
    alert(6, 'oblast:poltavska', 'oblast', 'full', 25, now),
    alert(7, 'oblast:kyivska', 'hromada', 'partial', 8, now, ['Бровари', 'Броварська громада', 'Великодимерська громада']),
    alert(8, 'oblast:odeska', 'hromada', 'partial', 70, now, ['Одеса', 'Чорноморськ']),
    alert(9, 'oblast:zaporizka', 'oblast', 'full', 150, now, [], 90),
    alert(10, 'oblast:kirovohradska', 'oblast', 'full', 145, now, [], 110),
  ];
}

function demoSources(now: number): SourceStatus[] {
  return [
    { source: 'kpszsu', lastSuccessAt: now - 0.5 * MIN, healthy: true },
    { source: 'kozakchornobay', lastSuccessAt: now - 1 * MIN, healthy: true },
    { source: 'sectorv666', lastSuccessAt: now - 14 * MIN, healthy: false },
    { source: 'alerts.in.ua', lastSuccessAt: now - 0.3 * MIN, healthy: true },
  ];
}

export function demoSnapshot(now: number): Snapshot {
  return {
    seq: 1000,
    at: now,
    alerts: demoAlerts(now).filter((a) => a.endedAt === null),
    tracks: SPECS.map((s) => buildTrack(s, now)),
    sources: demoSources(now),
  };
}

/**
 * The map as it looked at `at`, rebuilt from the same fixtures the way the API rebuilds
 * it from intervals and observations: nothing reported after `at` is visible.
 */
export function demoHistory(now: number, at: number): Snapshot {
  const alerts = demoAlerts(now)
    .filter((a) => a.startedAt <= at && (a.endedAt === null || a.endedAt > at))
    .map((a) => ({ ...a, endedAt: null }));
  const tracks: Track[] = [];
  for (const t of SPECS.map((s) => buildTrack(s, now))) {
    const path = t.path.filter((p) => p.at <= at);
    const lastPt = path[path.length - 1];
    if (!lastPt) continue;
    const kind = lastPt.kind;
    tracks.push({
      ...t,
      path,
      lastSeenAt: lastPt.at,
      last: {
        ...t.last,
        lat: lastPt.lat,
        lon: lastPt.lon,
        kind,
        observedAt: lastPt.at,
        relation: kind === 'launch' ? 'launch' : kind === 'destination' ? 'towards' : 'over',
        placeName: path.length === t.path.length ? t.last.placeName : null,
      },
    });
  }
  return { seq: 0, at, alerts, tracks, sources: demoSources(at) };
}

/**
 * A fake event stream on top of a snapshot taken at `start`: the Shahed group keeps
 * moving, a raion alert starts and ends, a revised track disappears and comes back.
 * Returns a stop function.
 */
export function startDemoStream(
  start: Snapshot,
  emit: (msg: ServerMessage) => void,
  intervalMs = 5000,
): () => void {
  let seq = start.seq;
  let tick = 0;
  const lead = start.tracks.find((t) => t.id === 101);
  let current = lead ? structuredClone(lead) : null;

  const send = (e: Extract<ServerMessage, { t: 'event' }>['e']) => {
    seq += 1;
    emit({ t: 'event', seq, at: Date.now(), e });
  };

  const timer = setInterval(() => {
    tick += 1;
    const now = Date.now();
    if (current && current.last.headingDeg !== null) {
      // Each tick the group "is reported" ~2 km further along its course.
      const next = destination(current.last.lat, current.last.lon, current.last.headingDeg, 2);
      current = {
        ...current,
        lastSeenAt: now,
        last: {
          ...current.last,
          id: current.last.id + 1,
          ...next,
          observedAt: now,
          placeName: 'Обухівський район',
          messageId: current.last.messageId + 1,
        },
        path: [...current.path, { ...next, at: now, kind: 'position' as const }].filter(
          (p) => now - p.at <= 60 * MIN,
        ),
      };
      send({ type: 'track.observed', track: current });
    }
    if (tick % 6 === 2) {
      send({
        type: 'alert.started',
        alert: {
          id: 50 + tick,
          regionId: 'raion:poltavska:кременчуцький',
          oblast: 'poltavska',
          level: 'raion',
          severity: 'full',
          areas: [],
          startedAt: now,
          endedAt: null,
        },
      });
    }
    if (tick % 6 === 5) send({ type: 'alert.ended', alertId: 50 + tick - 3, endedAt: now });
    if (tick % 4 === 0) {
      send({
        type: 'source.status',
        source: { source: 'kpszsu', lastSuccessAt: now, healthy: true },
      });
    }
  }, intervalMs);

  return () => clearInterval(timer);
}
