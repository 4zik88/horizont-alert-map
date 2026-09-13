import type { Db } from '../db/index.js';
import { Users } from '../db/users.js';
import { logger } from '../logger.js';
import { oblastByKey } from '../parser/oblasts.js';
import { TelegramApi, trySend } from '../bot/api.js';
import { fetchAlertState } from './client.js';

export interface AlertWatcherOptions {
  token: string;
  intervalMs: number;
  timeoutMs: number;
}

/**
 * Oblast air-raid alerts, reported separately from target warnings.
 *
 * Only transitions are messaged. The last known state per oblast is persisted, so a
 * redeploy during an active alert does not re-announce it to everyone — which is
 * exactly the kind of noise that gets an alerting bot muted.
 */
export class AlertWatcher {
  private readonly users: Users;
  private readonly api: TelegramApi;
  private readonly opts: AlertWatcherOptions;
  private readonly selectState;
  private readonly upsertState;
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;
  private running = false;

  constructor(db: Db, users: Users, api: TelegramApi, opts: AlertWatcherOptions) {
    this.users = users;
    this.api = api;
    this.opts = opts;

    this.selectState = db.prepare(`SELECT oblast, active FROM oblast_alerts`);
    this.upsertState = db.prepare(`
      INSERT INTO oblast_alerts (oblast, active, changed_at, updated_at)
      VALUES (@oblast, @active, @now, @now)
      ON CONFLICT(oblast) DO UPDATE SET
        active = @active,
        changed_at = CASE WHEN oblast_alerts.active <> @active THEN @now ELSE oblast_alerts.changed_at END,
        updated_at = @now
    `);
  }

  start(): void {
    this.schedule(10_000);
    logger.info('alert watcher started');
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    while (this.running) await new Promise((r) => setTimeout(r, 50));
    logger.info('alert watcher stopped');
  }

  private schedule(ms: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async tick(): Promise<void> {
    try {
      await this.runOnce();
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'alert poll failed',
      );
    }
    this.schedule(this.opts.intervalMs);
  }

  /** One poll. No timers — callable directly from tests. */
  async runOnce(now = Date.now()): Promise<{ starts: string[]; stops: string[]; sent: number }> {
    this.running = true;
    try {
      const state = await fetchAlertState(this.opts.token, this.opts.timeoutMs);
      if (state.active.size === 0) return { starts: [], stops: [], sent: 0 };

      const previous = new Map<string, boolean>(
        (this.selectState.all() as { oblast: string; active: number }[]).map((r) => [
          r.oblast,
          r.active === 1,
        ]),
      );

      const starts: string[] = [];
      const stops: string[] = [];

      for (const [oblast, active] of state.active) {
        const before = previous.get(oblast);
        this.upsertState.run({ oblast, active: active ? 1 : 0, now });

        // An oblast seen for the first time is recorded but never announced: on a
        // fresh database every active alert would otherwise look like it just started.
        if (before === undefined || before === active) continue;
        (active ? starts : stops).push(oblast);
      }

      if (starts.length === 0 && stops.length === 0) return { starts, stops, sent: 0 };

      let sent = 0;
      for (const user of this.users.notifiable()) {
        if (!user.oblast) continue;
        if (starts.includes(user.oblast)) {
          const name = oblastByKey(user.oblast)?.name ?? user.oblast;
          if (await trySend(this.api, user.chat_id, `🚨 Воздушная тревога — ${name} обл.`)) sent++;
        } else if (stops.includes(user.oblast)) {
          const name = oblastByKey(user.oblast)?.name ?? user.oblast;
          if (await trySend(this.api, user.chat_id, `✅ Отбой тревоги — ${name} обл.`)) sent++;
        }
      }

      logger.info({ starts, stops, sent }, 'oblast alert transitions');
      return { starts, stops, sent };
    } finally {
      this.running = false;
    }
  }
}
