import {
  FORECAST_SPEED_KMH,
  TRACK_TAIL_MS,
  type Alert,
  type Observation,
  type PointKind,
  type Relation,
  type SourceStatus,
  type TargetType,
  type Track,
} from '@horizont/contract';
import { DEFAULT_LINK, linkSighting, nextHeading, type OpenTrack } from '@horizont/geo';
import { appendEvent } from './events.js';
import type { Sql } from './sql.js';

/**
 * Everything the map reads and the worker publishes for it.
 *
 * The parser stores what each message said (`targets`). This module turns that into
 * what the map draws: tracks of joined sightings, alert intervals, and the events that
 * carry each change to open browsers.
 */

// ─── what a parsed target means on the map ──────────────────────────────────

/*
 * Only "над / повз / через" report where a target is. "курсом на X" says where it is
 * going — the old map drew those as if overhead, and 31 of 36 live markers were
 * destinations. A bare origin ("з Донецька") is drawn nowhere: it is where the target
 * came from, not where it is.
 */
export function kindOf(relation: string | null): PointKind | null {
  switch (relation) {
    case 'over':
    case 'past':
    case 'through':
      return 'position';
    case 'towards':
      return 'destination';
    case 'launch':
      return 'launch';
    default:
      return null;
  }
}

interface TargetRow {
  id: number;
  track_id: number | null;
  type: string;
  count: number;
  relation: string | null;
  to_name: string | null;
  to_lat: number | null;
  to_lon: number | null;
  from_name: string | null;
  from_lat: number | null;
  from_lon: number | null;
  course_deg: number | null;
  to_area: number;
  confidence: number | null;
  source: string | null;
  observed_at: number;
  channel: string;
  post_id: number;
}

const TARGET_COLUMNS = `
  t.id, t.track_id, t.type, t.count, t.relation, t.to_name, t.to_lat, t.to_lon,
  t.from_name, t.from_lat, t.from_lon, t.course_deg, t.to_area, t.confidence, t.source, t.observed_at,
  m.channel, m.message_id AS post_id`;

/** The map's reading of one stored target, or null when it draws nothing. */
export function toObservation(r: TargetRow): Observation | null {
  const kind = kindOf(r.relation);
  if (!kind) return null;
  // A launch is drawn at the site it came from; everything else at the named place.
  const lat = kind === 'launch' ? r.from_lat : r.to_lat;
  const lon = kind === 'launch' ? r.from_lon : r.to_lon;
  if (lat === null || lon === null) return null;

  const type = r.type as TargetType;
  const area = kind !== 'launch' && r.to_area === 1;
  return {
    id: r.id,
    trackId: r.track_id,
    type,
    count: r.count,
    relation: (r.relation ?? 'over') as Relation,
    kind,
    area,
    lat,
    lon,
    placeName: kind === 'launch' ? r.from_name : r.to_name,
    fromName: kind === 'launch' ? null : r.from_name,
    headingDeg: r.course_deg,
    speedKmh: kind === 'position' && !area ? FORECAST_SPEED_KMH[type] ?? null : null,
    confidence: r.confidence ?? 0,
    source: r.source === 'llm' ? 'llm' : 'rules',
    observedAt: r.observed_at,
    channel: r.channel,
    messageId: r.post_id,
  };
}

// ─── reading ─────────────────────────────────────────────────────────────────

/** Alerts in force at `at`. Live view: pass now. */
export async function alertsAt(sql: Sql, at: number): Promise<Alert[]> {
  const { rows } = await sql.query<{
    id: number; region_id: string; oblast: string; level: Alert['level'];
    severity: Alert['severity']; areas: string[]; started_at: number; ended_at: number | null;
  }>(
    `SELECT id, region_id, oblast, level, severity, areas, started_at, ended_at
       FROM alerts
      WHERE started_at <= $1 AND (ended_at IS NULL OR ended_at > $1)
      ORDER BY started_at`,
    [at],
  );
  return rows.map((r) => ({
    id: r.id,
    regionId: r.region_id,
    oblast: r.oblast,
    level: r.level,
    severity: r.severity,
    areas: r.areas ?? [],
    startedAt: r.started_at,
    // As seen at `at`, an alert that ends later was still open.
    endedAt: null,
  }));
}

/**
 * Tracks as they stood at `at`: every track with a sighting in the hour before, its
 * latest sighting up to `at`, and its path over that hour.
 *
 * An hour, not the three the timeline spans: past the 25-minute mark a track is drawn
 * grey, and a map full of grey tracks from a raid that ended long ago buries the live
 * ones. The timeline reaches further back by asking for an earlier `at`.
 */
export async function tracksAt(sql: Sql, at: number, only?: number[]): Promise<Track[]> {
  const params: unknown[] = [at - TRACK_TAIL_MS, at];
  let filter = '';
  if (only) {
    params.push(only);
    filter = 'AND t.track_id = ANY($3::bigint[])';
  }
  const { rows } = await sql.query<TargetRow>(
    `SELECT ${TARGET_COLUMNS}
       FROM targets t JOIN messages m ON m.id = t.message_id
      WHERE t.track_id IS NOT NULL AND t.observed_at > $1 AND t.observed_at <= $2 ${filter}
      ORDER BY t.observed_at, t.id`,
    params,
  );

  const byTrack = new Map<number, Observation[]>();
  for (const r of rows) {
    const o = toObservation(r);
    if (!o || o.trackId === null) continue;
    const list = byTrack.get(o.trackId);
    if (list) list.push(o);
    else byTrack.set(o.trackId, [o]);
  }

  const tracks: Track[] = [];
  for (const [id, obs] of byTrack) {
    const last = obs.at(-1)!;
    tracks.push({
      id,
      type: last.type,
      count: last.count,
      last,
      path: obs.map((o) => ({ lat: o.lat, lon: o.lon, at: o.observedAt, kind: o.kind })),
      confidence: last.confidence,
      firstSeenAt: obs[0]!.observedAt,
      lastSeenAt: last.observedAt,
    });
  }
  return tracks.sort((a, b) => a.lastSeenAt - b.lastSeenAt);
}

/** Channel health. A channel is healthy while it polled successfully recently. */
export async function sourceStatuses(sql: Sql, now: number, staleAfterMs: number): Promise<SourceStatus[]> {
  const { rows } = await sql.query<{ channel: string; last_success_at: number | null; enabled: number }>(
    'SELECT channel, last_success_at, enabled FROM channel_state ORDER BY channel',
  );
  return rows
    .filter((r) => r.enabled === 1)
    .map((r) => ({
      source: r.channel,
      lastSuccessAt: r.last_success_at,
      healthy: r.last_success_at !== null && now - r.last_success_at <= staleAfterMs,
    }));
}

// ─── publishing: targets -> tracks ───────────────────────────────────────────

export interface PublishOptions {
  /** Typical speed per target type, km/h, for the tracker's distance gate. */
  speedKmh: (type: string) => number;
  now?: number;
}

/** Track ids a message's targets belong to. Read before re-saving an edited message. */
export async function trackIdsOfMessage(sql: Sql, messageDbId: number): Promise<number[]> {
  const { rows } = await sql.query<{ track_id: number }>(
    'SELECT DISTINCT track_id FROM targets WHERE message_id = $1 AND track_id IS NOT NULL',
    [messageDbId],
  );
  return rows.map((r) => r.track_id);
}

/**
 * Join a freshly saved message's targets into tracks and announce the result.
 *
 * `previousTrackIds` are the tracks the message fed before an edit replaced its
 * targets; any of them left without sightings is deleted, and the rest are re-read,
 * so an edit that moves a drone does not leave its old position behind.
 */
export async function publishMessage(
  sql: Sql,
  messageDbId: number,
  opts: PublishOptions & { previousTrackIds?: number[] },
): Promise<{ tracks: number[] }> {
  const now = opts.now ?? Date.now();
  const link = { ...DEFAULT_LINK, speedKmh: opts.speedKmh };

  return sql.transaction(async (tx) => {
    const { rows } = await tx.query<TargetRow>(
      `SELECT ${TARGET_COLUMNS}
         FROM targets t JOIN messages m ON m.id = t.message_id
        WHERE t.message_id = $1
        ORDER BY t.seq`,
      [messageDbId],
    );

    const touched = new Set<number>();
    for (const row of rows) {
      const o = toObservation(row);
      if (!o) continue;

      const { rows: open } = await tx.query<{
        id: number; type: string; last_lat: number; last_lon: number; last_kind: string;
        last_seen_at: number; heading_deg: number | null;
      }>(
        `SELECT id, type, last_lat, last_lon, last_kind, last_seen_at, heading_deg
           FROM target_tracks
          WHERE type = $1 AND last_seen_at >= $2 AND last_seen_at <= $3`,
        [o.type, o.observedAt - link.maxGapMs, o.observedAt + link.reorderMs],
      );
      const candidates: OpenTrack[] = open.map((t) => ({
        id: t.id,
        type: t.type,
        lat: t.last_lat,
        lon: t.last_lon,
        lastKind: t.last_kind as PointKind,
        lastSeenAt: t.last_seen_at,
        headingDeg: t.heading_deg,
      }));
      const sighting = {
        type: o.type, lat: o.lat, lon: o.lon, kind: o.kind,
        headingDeg: o.headingDeg, observedAt: o.observedAt,
      };

      const joined = linkSighting(candidates, sighting, link);
      let trackId: number;
      if (joined === null) {
        const { rows: created } = await tx.query<{ id: number }>(
          `INSERT INTO target_tracks
             (type, count, first_seen_at, last_seen_at, last_lat, last_lon, heading_deg, confidence, last_kind)
           VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [o.type, o.count, o.observedAt, o.lat, o.lon, o.headingDeg, o.confidence, o.kind],
        );
        trackId = created[0]!.id;
      } else {
        const t = candidates.find((c) => c.id === joined)!;
        // A late report extends the path but does not move the marker backwards.
        if (o.observedAt >= t.lastSeenAt) {
          await tx.query(
            `UPDATE target_tracks
                SET last_seen_at = $2, last_lat = $3, last_lon = $4, heading_deg = $5,
                    count = $6, confidence = $7, last_kind = $8
              WHERE id = $1`,
            [joined, o.observedAt, o.lat, o.lon, nextHeading(t, sighting), o.count, o.confidence, o.kind],
          );
        }
        trackId = joined;
      }
      await tx.query('UPDATE targets SET track_id = $2 WHERE id = $1', [o.id, trackId]);
      touched.add(trackId);
    }

    for (const id of touched) {
      const [track] = await tracksAt(tx, now, [id]);
      if (track) await appendEvent(tx, { type: 'track.observed', track }, now);
    }

    for (const id of opts.previousTrackIds ?? []) {
      if (touched.has(id)) continue;
      await reviseTrack(tx, id, now);
    }

    return { tracks: [...touched] };
  });
}

/** Re-read a track after it lost sightings; delete it when none are left. */
async function reviseTrack(tx: Sql, id: number, now: number): Promise<void> {
  const { rows } = await tx.query<TargetRow>(
    `SELECT ${TARGET_COLUMNS}
       FROM targets t JOIN messages m ON m.id = t.message_id
      WHERE t.track_id = $1
      ORDER BY t.observed_at DESC, t.id DESC
      LIMIT 1`,
    [id],
  );
  const last = rows[0] ? toObservation(rows[0]) : null;
  if (!last) {
    await tx.query('DELETE FROM target_tracks WHERE id = $1', [id]);
    await appendEvent(tx, { type: 'track.revised', trackId: id, track: null }, now);
    return;
  }
  await tx.query(
    `UPDATE target_tracks SET last_seen_at = $2, last_lat = $3, last_lon = $4, count = $5,
            confidence = $6, last_kind = $7 WHERE id = $1`,
    [id, last.observedAt, last.lat, last.lon, last.count, last.confidence, last.kind],
  );
  const [track] = await tracksAt(tx, now, [id]);
  await appendEvent(tx, { type: 'track.revised', trackId: id, track: track ?? null }, now);
}

// ─── publishing: alerts ──────────────────────────────────────────────────────

export interface DesiredAlert {
  regionId: string;
  oblast: string;
  level: Alert['level'];
  severity: Alert['severity'];
  areas: string[];
}

const sameAlert = (a: DesiredAlert, b: { level: string; severity: string; areas: string[] }) =>
  a.level === b.level && a.severity === b.severity &&
  a.areas.length === b.areas.length && a.areas.every((x, i) => x === b.areas[i]);

/**
 * Make the open alert intervals match the alert feed's current state.
 *
 * Only call with a state the feed actually reported. An empty `desired` closes every
 * alert in the country, which is exactly the false all-clear the watcher guards
 * against upstream.
 */
export async function syncAlerts(
  sql: Sql,
  desired: DesiredAlert[],
  now = Date.now(),
): Promise<{ started: number; ended: number }> {
  return sql.transaction(async (tx) => {
    const { rows: open } = await tx.query<{
      id: number; region_id: string; level: string; severity: string; areas: string[];
    }>(`SELECT id, region_id, level, severity, areas FROM alerts WHERE ended_at IS NULL AND alert_type = 'air_raid'`);

    const want = new Map(desired.map((d) => [d.regionId, { ...d, areas: [...d.areas].sort() }]));
    let started = 0;
    let ended = 0;
    const keep = new Set<string>();

    for (const a of open) {
      const d = want.get(a.region_id);
      if (d && sameAlert(d, a)) {
        keep.add(a.region_id);
        continue;
      }
      await tx.query('UPDATE alerts SET ended_at = $2 WHERE id = $1', [a.id, now]);
      await appendEvent(tx, { type: 'alert.ended', alertId: a.id, endedAt: now }, now);
      ended++;
    }

    for (const d of want.values()) {
      if (keep.has(d.regionId)) continue;
      const { rows } = await tx.query<{ id: number }>(
        `INSERT INTO alerts (region_id, oblast, level, severity, areas, started_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [d.regionId, d.oblast, d.level, d.severity, d.areas, now],
      );
      const alert: Alert = {
        id: rows[0]!.id, regionId: d.regionId, oblast: d.oblast, level: d.level,
        severity: d.severity, areas: d.areas, startedAt: now, endedAt: null,
      };
      await appendEvent(tx, { type: 'alert.started', alert }, now);
      started++;
    }
    return { started, ended };
  });
}

/** Keep a week of tracks; their targets go with their messages. */
export async function pruneTracks(sql: Sql, now = Date.now(), keepMs = 7 * 86_400_000): Promise<number> {
  return (await sql.query('DELETE FROM target_tracks WHERE last_seen_at < $1', [now - keepMs])).rowCount;
}
