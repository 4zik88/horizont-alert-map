/**
 * @horizont/contract — the shapes that cross the wire between the API and the map.
 *
 * Types only, plus a few constants. No runtime dependencies, so the browser bundle
 * pays nothing for it. All times are epoch milliseconds (UTC).
 */

export type TargetType =
  | 'uav' | 'jet_uav' | 'cruise' | 'ballistic' | 'kab' | 'aviation' | 'recon' | 'unknown';

/**
 * What the reported coordinate means. This is the most important field on the map.
 *
 * - `position`: the message says where the target IS ("над", "повз", "через").
 * - `destination`: the message says where it is GOING ("курсом на X"). It is not there
 *   and may never get there. Drawn hollow; never projected forward; no arrival time.
 * - `launch`: an enemy launch site. Never a target position.
 */
export type PointKind = 'position' | 'destination' | 'launch';

export type Relation = 'towards' | 'past' | 'through' | 'over' | 'from' | 'launch';

/**
 * Speed used to project a reported position forward, km/h. Null means the type is
 * never projected: a ballistic missile is drawn only where it was reported, and a KAB,
 * aircraft or unidentified target has no meaningful cruise speed to extrapolate.
 * Projected values match the bot's (`TYPE_SPEED_KMH` in the parser) so the map and the
 * warnings never disagree about when something arrives.
 */
export const FORECAST_SPEED_KMH: Record<TargetType, number | null> = {
  uav: 180,
  jet_uav: 600,
  cruise: 800,
  ballistic: null,
  kab: null,
  aviation: null,
  recon: 150,
  unknown: null,
};

/** A target report older than this is drawn grey and never projected. */
export const STALE_AFTER_MS = 25 * 60_000;
/** How far back the map and the timeline reach. */
export const HISTORY_MS = 3 * 60 * 60_000;
/** Track polylines fade out over this window. */
export const TRACK_TAIL_MS = 60 * 60_000;

/** `oblast:<key>` or `raion:<oblastKey>:<raionKey>`, matching map-regions.geojson ids. */
export type RegionId = string;

export interface Alert {
  id: number;
  /** The polygon to paint. Hromada-level alerts name their oblast here. */
  regionId: RegionId;
  oblast: string;
  /** Granularity the alert was declared at. */
  level: 'oblast' | 'raion' | 'hromada';
  /** `full`: red. `partial`: yellow (only some raions or hromadas). */
  severity: 'full' | 'partial';
  /** Hromada or city names, for hromada-level alerts the map has no polygon for. */
  areas: string[];
  startedAt: number;
  endedAt: number | null;
}

export interface Observation {
  id: number;
  trackId: number | null;
  type: TargetType;
  count: number;
  relation: Relation;
  kind: PointKind;
  /**
   * The place is a whole region (an oblast, a sea) and the coordinate is its centre.
   * Draw it as "somewhere in X": never projected, no arrival time, no distance.
   */
  area: boolean;
  /** The one coordinate the message gives; see `kind` for what it means. */
  lat: number;
  lon: number;
  placeName: string | null;
  fromName: string | null;
  /** Compass course, 0 = north. Null when the message gives no direction. */
  headingDeg: number | null;
  speedKmh: number | null;
  confidence: number;
  source: 'rules' | 'llm';
  observedAt: number;
  channel: string;
  messageId: number;
}

export interface Track {
  id: number;
  type: TargetType;
  count: number;
  /** The latest observation, which is what the marker draws. */
  last: Observation;
  /** Reported points over the last hour, oldest first. */
  path: { lat: number; lon: number; at: number; kind: PointKind }[];
  confidence: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface SourceStatus {
  source: string;
  lastSuccessAt: number | null;
  healthy: boolean;
}

export interface Snapshot {
  seq: number;
  at: number;
  alerts: Alert[];
  tracks: Track[];
  sources: SourceStatus[];
}

export type DomainEvent =
  | { type: 'alert.started'; alert: Alert }
  | { type: 'alert.ended'; alertId: number; endedAt: number }
  | { type: 'track.observed'; track: Track }
  | { type: 'track.revised'; track: Track | null; trackId: number }
  | { type: 'source.status'; source: SourceStatus };

export type ClientMessage =
  | { t: 'resume'; seq: number | null }
  | { t: 'ping' };

export type ServerMessage =
  | ({ t: 'snapshot' } & Snapshot)
  | { t: 'event'; seq: number; at: number; e: DomainEvent }
  | { t: 'pong' };

/** The user, as the map may see them. Never carries coordinates. */
export interface Me {
  name: string | null;
  /** Oblast key from the location shared with the bot, for "only my oblast". */
  oblast: string | null;
}

export const DISCLAIMER = 'Дані з відкритих джерел, не є офіційним попередженням.';
