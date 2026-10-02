import type { Db } from '../db/index.js';
import { AppState, Users } from '../db/users.js';
import { logger } from '../logger.js';
import type { TargetType } from '@horizont/parser';
import { TelegramApi, trySend } from '../bot/api.js';
import { formatAlertBatch, subjectOf, type AlertLine } from '../bot/format.js';
import {
  DEFAULT_PROXIMITY,
  matchTarget,
  type ProximityOptions,
  type TargetView,
} from './proximity.js';

const CURSOR_KEY = 'notify_target_cursor';

export interface NotifierOptions {
  intervalMs: number;
  /** Spec rule: at most one message about a given target to a given user per window. */
  cooldownMs: number;
  /**
   * How long a warning that says nothing new is held back.
   *
   * The cooldown alone still let a drone loitering over one town produce the same
   * sentence every five minutes. A line whose distance has not moved carries no
   * information the reader does not already have, so it waits longer; a line that has
   * changed is released as soon as the cooldown allows.
   */
  repeatMs: number;
  /** How much the distance must change for a warning to count as new, as a fraction. */
  materialChange: number;
  batchSize: number;
  proximity: Omit<ProximityOptions, 'now'>;
}

export const DEFAULT_NOTIFIER: NotifierOptions = {
  intervalMs: 15_000,
  cooldownMs: 5 * 60_000,
  repeatMs: 20 * 60_000,
  materialChange: 0.25,
  batchSize: 300,
  proximity: DEFAULT_PROXIMITY,
};

interface TargetRow {
  id: number;
  type: string;
  count: number;
  to_name: string | null;
  to_lat: number | null;
  to_lon: number | null;
  from_lat: number | null;
  from_lon: number | null;
  course_deg: number | null;
  confidence: number;
  observed_at: number;
}

/**
 * Sends proximity warnings.
 *
 * Reads forward through the `targets` table by id and remembers the cursor, so a
 * restart neither replays old warnings nor silently skips new ones. Targets that are
 * already stale when first seen are still walked past — the cursor advances
 * regardless — but `matchTarget` refuses to alert on them.
 */
export class Notifier {
  private readonly db: Db;
  private readonly users: Users;
  private readonly state: AppState;
  private readonly api: TelegramApi;
  private readonly opts: NotifierOptions;
  private readonly selectSince;
  private readonly selectRecentNotice;
  private readonly recordNotice;
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;
  private running = false;

  constructor(db: Db, users: Users, state: AppState, api: TelegramApi, opts: NotifierOptions) {
    this.db = db;
    this.users = users;
    this.state = state;
    this.api = api;
    this.opts = opts;

    this.selectSince = db.prepare(`
      SELECT id, type, count, to_name, to_lat, to_lon, from_lat, from_lon,
             course_deg, confidence, observed_at
        FROM targets
       WHERE id > ?
       ORDER BY id
       LIMIT ?
    `);

    this.selectRecentNotice = db.prepare(
      `SELECT sent_at, distance_km FROM notice_ledger WHERE chat_id = ? AND subject = ?`,
    );

    this.recordNotice = db.prepare(`
      INSERT INTO notice_ledger (chat_id, subject, distance_km, sent_at)
      VALUES (@chatId, @subject, @distanceKm, @now)
      ON CONFLICT(chat_id, subject) DO UPDATE SET distance_km = @distanceKm, sent_at = @now
    `);
  }

  start(): void {
    this.schedule(5_000);
    logger.info('notifier started');
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    while (this.running) await new Promise((r) => setTimeout(r, 50));
    logger.info('notifier stopped');
  }

  private schedule(ms: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async tick(): Promise<void> {
    let drained = false;
    try {
      const result = await this.runOnce();
      drained = result.scanned === this.opts.batchSize;
    } catch (error) {
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'notifier batch failed',
      );
    }
    this.schedule(drained ? 500 : this.opts.intervalMs);
  }

  /** One pass. No timers — callable directly from tests. */
  async runOnce(now = Date.now()): Promise<{ scanned: number; sent: number; recipients: number }> {
    this.running = true;
    try {
      const cursor = this.state.getNumber(CURSOR_KEY, 0);
      const targets = this.selectSince.all(cursor, this.opts.batchSize) as TargetRow[];
      if (targets.length === 0) return { scanned: 0, sent: 0, recipients: 0 };

      const users = this.users.notifiable();
      const proximity: ProximityOptions = { ...this.opts.proximity, now };

      // Group by user so a burst becomes one message rather than a dozen. A mass
      // attack can match a single user against many targets at once, and the
      // per-target cooldown alone does not bound that.
      const pending = new Map<number, { lines: AlertLine[] }>();

      for (const row of targets) {
        const target = toTargetView(row);
        for (const user of users) {
          if (user.lat === null || user.lon === null) continue;

          const match = matchTarget(
            target,
            { chatId: user.chat_id, lat: user.lat, lon: user.lon, radiusKm: user.radius_km },
            proximity,
          );
          if (!match) continue;

          const line: AlertLine = {
            type: target.type,
            count: row.count,
            toName: target.toName,
            distanceKm: match.distanceKm,
            etaMin: match.etaMin,
            reason: match.reason,
          };
          if (this.alreadySaid(user.chat_id, line, now)) continue;

          const bucket = pending.get(user.chat_id) ?? { lines: [] };
          bucket.lines.push(line);
          pending.set(user.chat_id, bucket);
        }
      }

      let sent = 0;
      for (const [chatId, bucket] of pending) {
        // Nearest first: the most urgent line should be the one they read.
        bucket.lines.sort((a, b) => a.distanceKm - b.distanceKm);
        const delivered = await trySend(this.api, chatId, formatAlertBatch(bucket.lines));
        if (!delivered) continue;

        sent += bucket.lines.length;
        // Record only what was actually delivered, so a failed send is retried on the
        // next pass rather than silently swallowed by the cooldown.
        this.db.transaction(() => {
          for (const line of bucket.lines) {
            this.recordNotice.run({
              chatId,
              subject: subjectOf(line),
              distanceKm: line.distanceKm,
              now,
            });
          }
        })();
      }

      const lastId = targets.at(-1)!.id;
      this.state.setNumber(CURSOR_KEY, lastId, now);

      if (sent > 0) {
        // Never log chat ids alongside anything locational.
        logger.info({ scanned: targets.length, alerts: sent, recipients: pending.size }, 'notified');
      }

      return { scanned: targets.length, sent, recipients: pending.size };
    } finally {
      this.running = false;
    }
  }

  /**
   * Has this reader already been told this, recently enough that saying it again would
   * be noise rather than news?
   *
   * Two gates. The cooldown is the spec's floor and nothing crosses it. Past that, a
   * warning still has to have *changed* — a drone circling one town for an hour
   * produces the identical sentence every poll, and repeating it teaches the reader to
   * ignore the bot. An unchanged line waits out the longer repeat window instead.
   */
  private alreadySaid(chatId: number, line: AlertLine, now: number): boolean {
    const row = this.selectRecentNotice.get(chatId, subjectOf(line)) as
      { sent_at: number; distance_km: number } | undefined;
    if (row === undefined) return false;

    const since = now - row.sent_at;
    if (since < this.opts.cooldownMs) return true;
    if (since >= this.opts.repeatMs) return false;

    // Guard the division: a target reported directly overhead has distance 0, and
    // anything moving away from 0 is a change worth hearing about.
    const previous = row.distance_km;
    const moved = previous <= 0
      ? line.distanceKm > 0
      : Math.abs(line.distanceKm - previous) / previous >= this.opts.materialChange;

    return !moved;
  }
}

function toTargetView(row: TargetRow): TargetView {
  return {
    id: row.id,
    type: row.type as TargetType,
    toName: row.to_name,
    toLat: row.to_lat,
    toLon: row.to_lon,
    fromLat: row.from_lat,
    fromLon: row.from_lon,
    courseDeg: row.course_deg,
    confidence: row.confidence,
    observedAt: row.observed_at,
  };
}
