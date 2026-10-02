import type { Db } from '../db/index.js';
import { AppState } from '../db/users.js';
import { logger } from '../logger.js';
import { pruneLlmCache, pruneMessages, pruneNoticeLedger } from './retention.js';

const LAST_RUN_KEY = 'maintenance_last_run';

export interface MaintenanceOptions {
  /** Messages older than this are deleted, along with everything derived from them. */
  retentionMs: number;
  /** How often the work should happen — daily in practice. */
  intervalMs: number;
}

/**
 * Daily housekeeping: drop messages, warnings and model answers past retention.
 *
 * Backups are not done here: Postgres on Railway has provider-managed backups, which
 * replaced the nightly `VACUUM INTO` copy this used to take of the SQLite file.
 *
 * Driven by a timestamp in `app_state` rather than a wall-clock schedule, because
 * this process restarts on every deploy. A cron-style "run at 03:00" would be skipped
 * entirely by a deploy at 02:59, and a plain interval timer would restart its count
 * from zero each time and could go for weeks without ever firing.
 *
 * The tick is deliberately much shorter than the interval so a restart notices a
 * *missed* run promptly instead of waiting a full day for the next one.
 */
export class Maintenance {
  private readonly db: Db;
  private readonly state: AppState;
  private readonly opts: MaintenanceOptions;
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;
  private running = false;

  constructor(db: Db, opts: MaintenanceOptions) {
    this.db = db;
    this.state = new AppState(db);
    this.opts = opts;
  }

  start(): void {
    // Not immediately on boot: a crash loop would otherwise prune on every restart.
    this.schedule(60_000);
    logger.info(
      { retentionDays: Math.round(this.opts.retentionMs / 86_400_000) },
      'maintenance scheduled',
    );
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    while (this.running) await new Promise((r) => setTimeout(r, 50));
  }

  private schedule(ms: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => void this.tick(), ms);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    try {
      await this.runIfDue();
    } catch (error) {
      // Never fatal: failed housekeeping must not take the alerting service down with it.
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'maintenance failed',
      );
    }
    this.schedule(Math.min(this.opts.intervalMs, 3_600_000));
  }

  /** Run the work if enough time has passed. Pure enough to call from a test. */
  async runIfDue(now = Date.now()): Promise<boolean> {
    this.running = true;
    try {
      const last = await this.state.getNumber(LAST_RUN_KEY, 0);
      if (last > 0 && now - last < this.opts.intervalMs) return false;

      await pruneMessages(this.db, this.opts.retentionMs, now);
      await pruneNoticeLedger(this.db, now);
      await pruneLlmCache(this.db, now);
      await this.state.setNumber(LAST_RUN_KEY, now, now);
      return true;
    } finally {
      this.running = false;
    }
  }
}

export { pruneLlmCache, pruneMessages, pruneNoticeLedger } from './retention.js';
