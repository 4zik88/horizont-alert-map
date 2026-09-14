import type { Db } from '../db/index.js';
import { OBLASTS } from '../parser/oblasts.js';
import { stripBoilerplate } from '../parser/clean.js';

/**
 * Read model for the map.
 *
 * One endpoint returns everything the page needs, because on a phone three round
 * trips cost more than the handful of extra kilobytes.
 *
 * Two product rules are enforced here rather than in the browser, so a bug in the
 * page cannot break them: messages flagged sensitive never leave the server, and
 * anything the parser could not resolve appears in the feed as text with no marker.
 */

export interface MapTarget {
  id: number;
  type: string;
  count: number;
  label: string | null;
  lat: number;
  lon: number;
  fromLat: number | null;
  fromLon: number | null;
  course: number | null;
  relation: string;
  confidence: number;
  at: number;
}

/**
 * A reported launch, drawn at its origin.
 *
 * Deliberately a separate collection rather than a target with a flag: a launch is
 * the one thing on this map that is *not* where a threat currently is, and keeping
 * the two apart in the payload is what stops a later change from quietly rendering
 * it as one.
 */
export interface MapLaunch {
  id: number;
  type: string;
  count: number;
  label: string | null;
  lat: number;
  lon: number;
  course: number | null;
  at: number;
}

export interface FeedItem {
  id: number;
  channel: string;
  text: string;
  at: number;
  parsed: boolean;
}

export interface MapState {
  now: number;
  targets: MapTarget[];
  launches: MapLaunch[];
  feed: FeedItem[];
  alerts: {
    oblast: string;
    name: string;
    active: boolean;
    level: string;
    /** Normalised raion names under warning, for per-raion shading. */
    areas: string[];
    since: number;
  }[];
  channels: { channel: string; lastSuccessAt: number | null }[];
}

export interface ApiOptions {
  /** How far back the map shows targets. Older ones are dropped, not faded. */
  targetWindowMs: number;
  feedLimit: number;
}

/** Stored as JSON text; a malformed value must not take the whole response down. */
function parseAreas(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

interface TargetRow {
  id: number; type: string; count: number;
  to_name: string | null; to_lat: number; to_lon: number;
  from_lat: number | null; from_lon: number | null;
  course_deg: number | null; relation: string; confidence: number; observed_at: number;
}

interface LaunchRow {
  id: number; type: string; count: number;
  from_name: string | null; from_lat: number; from_lon: number;
  course_deg: number | null; observed_at: number;
}

interface FeedRow {
  id: number; channel: string; text: string; posted_at: number; parse_state: string;
}

export class MapApi {
  private readonly selectTargets;
  private readonly selectLaunches;
  private readonly selectFeed;
  private readonly selectAlerts;
  private readonly selectChannels;
  private readonly opts: ApiOptions;

  constructor(db: Db, opts: ApiOptions) {
    this.opts = opts;

    // Only targets with a real position and enough confidence to be worth drawing.
    this.selectTargets = db.prepare(`
      SELECT t.id, t.type, t.count, t.to_name, t.to_lat, t.to_lon,
             t.from_lat, t.from_lon, t.course_deg, t.relation, t.confidence, t.observed_at
        FROM targets t
        JOIN messages m ON m.id = t.message_id
       WHERE t.observed_at >= ?
         AND t.to_lat IS NOT NULL
         AND m.is_sensitive = 0
       ORDER BY t.observed_at DESC
       LIMIT 800
    `);

    /*
     * Launch reports only. A plain `from` also has an origin and no destination —
     * "шахед залітає з Одещини" is a transit whose position is unknown — and drawing
     * that as a launch claimed a launch from Ukrainian-held Odesa. The parser marks
     * a genuine launch with its own relation; nothing else is drawn here.
     */
    this.selectLaunches = db.prepare(`
      SELECT t.id, t.type, t.count, t.from_name, t.from_lat, t.from_lon,
             t.course_deg, t.observed_at
        FROM targets t
        JOIN messages m ON m.id = t.message_id
       WHERE t.observed_at >= ?
         AND t.to_lat IS NULL
         AND t.from_lat IS NOT NULL
         AND t.relation = 'launch'
         AND m.is_sensitive = 0
       ORDER BY t.observed_at DESC
       LIMIT 200
    `);

    // The feed carries parsed and unparsed messages alike — unresolved text is shown
    // as text, which is the specified behaviour — but never sensitive ones.
    this.selectFeed = db.prepare(`
      SELECT id, channel, text, posted_at, parse_state
        FROM messages
       WHERE is_sensitive = 0 AND text <> ''
       ORDER BY posted_at DESC
       LIMIT ?
    `);

    this.selectAlerts = db.prepare(
      `SELECT oblast, active, level, areas, changed_at FROM oblast_alerts`,
    );
    this.selectChannels = db.prepare(`SELECT channel, last_success_at FROM channel_state`);
  }

  state(now = Date.now()): MapState {
    const since = now - this.opts.targetWindowMs;

    const targets = (this.selectTargets.all(since) as TargetRow[]).map(
      (r): MapTarget => ({
        id: r.id,
        type: r.type,
        count: r.count,
        label: r.to_name,
        lat: r.to_lat,
        lon: r.to_lon,
        fromLat: r.from_lat,
        fromLon: r.from_lon,
        course: r.course_deg,
        relation: r.relation,
        // Rounded: extra precision only inflates the payload on a phone.
        confidence: Math.round(r.confidence * 100) / 100,
        at: r.observed_at,
      }),
    );

    const launches = (this.selectLaunches.all(since) as LaunchRow[]).map(
      (r): MapLaunch => ({
        id: r.id,
        type: r.type,
        count: r.count,
        label: r.from_name,
        lat: r.from_lat,
        lon: r.from_lon,
        course: r.course_deg,
        at: r.observed_at,
      }),
    );

    const feed = (this.selectFeed.all(this.opts.feedLimit) as FeedRow[]).map(
      (r): FeedItem => ({
        id: r.id,
        channel: r.channel,
        // Same trim the parser applies: "Підписатися на ..." on every post is noise
        // that pushes the actual report off a phone screen.
        text: stripBoilerplate(r.text) || r.text,
        at: r.posted_at,
        parsed: r.parse_state === 'parsed',
      }),
    );

    const alertRows = this.selectAlerts.all() as
      { oblast: string; active: number; level: string; areas: string; changed_at: number }[];
    const byKey = new Map(alertRows.map((r) => [r.oblast, r]));
    const alerts = OBLASTS.map((o) => {
      const row = byKey.get(o.key);
      return {
        oblast: o.key,
        name: o.name,
        active: row?.active === 1,
        level: row?.level ?? 'none',
        areas: parseAreas(row?.areas),
        since: row?.changed_at ?? 0,
      };
    });

    const channels = (this.selectChannels.all() as { channel: string; last_success_at: number | null }[])
      .map((r) => ({ channel: r.channel, lastSuccessAt: r.last_success_at }));

    return { now, targets, launches, feed, alerts, channels };
  }
}
