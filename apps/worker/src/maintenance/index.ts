import type { Db } from '../db/index.js';
import { AppState } from '../db/users.js';
import { logger } from '../logger.js';
import { runBackup, type BackupOptions } from './backup.js';
import { pruneLlmCache, pruneMessages, pruneNoticeLedger } from './retention.js';

const LAST_RUN_KEY = 'maintenance_last_run';

export interface MaintenanceOptions {
  backup: BackupOptions;
  /** Messages older than this are deleted, along with everything derived from them. */
  retentionMs: number;
  /** How often the work should happen — daily in practice. */
  intervalMs: number;
}

/**
 * Daily housekeeping: back the database up, then drop messages past retention.
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
    // Not immediately on boot: a crash loop would otherwise back up on every restart.
    this.schedule(60_000);
    logger.info(
      { dir: this.opts.backup.dir, keep: this.opts.backup.keep,
        retentionDays: Math.round(this.opts.retentionMs / 86_400_000) },
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
      this.runIfDue();
    } catch (error) {
      // Never fatal: a failed backup must not take the alerting service down with it.
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'maintenance failed',
      );
    }
    this.schedule(Math.min(this.opts.intervalMs, 3_600_000));
  }

  /** Run the work if enough time has passed. Pure enough to call from a test. */
  runIfDue(now = Date.now()): boolean {
    const last = this.state.getNumber(LAST_RUN_KEY, 0);
    if (last > 0 && now - last < this.opts.intervalMs) return false;

    this.running = true;
    try {
      runBackup(this.db, this.opts.backup, now);
      pruneMessages(this.db, this.opts.retentionMs, now);
      pruneNoticeLedger(this.db, now);
      pruneLlmCache(this.db, now);
      this.state.setNumber(LAST_RUN_KEY, now, now);
      return true;
    } finally {
      this.running = false;
    }
  }
}

export { runBackup, prune, backupName } from './backup.js';
export { pruneLlmCache, pruneMessages, pruneNoticeLedger } from './retention.js';
