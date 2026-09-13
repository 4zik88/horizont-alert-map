import type { Db } from '../db/index.js';
import { AppState, Users } from '../db/users.js';
import { logger } from '../logger.js';
import type { TargetType } from '../parser/targetTypes.js';
import { TelegramApi, trySend } from '../bot/api.js';
import { formatAlertBatch, type AlertLine } from '../bot/format.js';
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
  batchSize: number;
  proximity: Omit<ProximityOptions, 'now'>;
}

export const DEFAULT_NOTIFIER: NotifierOptions = {
  intervalMs: 15_000,
  cooldownMs: 5 * 60_000,
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
      `SELECT sent_at FROM notifications WHERE chat_id = ? AND target_id = ?`,
    );

    this.recordNotice = db.prepare(`
      INSERT INTO notifications (chat_id, target_id, sent_at) VALUES (@chatId, @targetId, @now)
      ON CONFLICT(chat_id, target_id) DO UPDATE SET sent_at = @now
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
      const pending = new Map<number, { lines: AlertLine[]; targetIds: number[] }>();

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
          if (this.recentlyNotified(user.chat_id, target.id, now)) continue;

          const bucket = pending.get(user.chat_id) ?? { lines: [], targetIds: [] };
          bucket.lines.push({
            type: target.type,
            count: row.count,
            toName: target.toName,
            distanceKm: match.distanceKm,
            reason: match.reason,
          });
          bucket.targetIds.push(target.id);
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
          for (const targetId of bucket.targetIds) {
            this.recordNotice.run({ chatId, targetId, now });
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

  private recentlyNotified(chatId: number, targetId: number, now: number): boolean {
    const row = this.selectRecentNotice.get(chatId, targetId) as { sent_at: number } | undefined;
    return row !== undefined && now - row.sent_at < this.opts.cooldownMs;
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
