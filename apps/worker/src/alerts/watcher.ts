import type { Db } from '../db/index.js';
import { Users } from '../db/users.js';
import { logger } from '../logger.js';
import { oblastByKey } from '@horizont/parser';
import { raionName, raionsOf } from '@horizont/geo/node';
import { TelegramApi, trySend } from '../bot/api.js';
import { fetchAlertState, isActive, type AlertLevel, type AlertProvider } from './client.js';

export interface AlertWatcherOptions {
  provider: AlertProvider;
  token: string | undefined;
  intervalMs: number;
  timeoutMs: number;
}

/**
 * Air-raid alerts, reported separately from target warnings.
 *
 * Declared per **raion**, which is how the feed itself declares them. An oblast is
 * roughly the size of a small country, so "Повітряна тривога — Вінницька обл." told a
 * reader in Kozyatyn that something was happening somewhere, usually nowhere near
 * them — and an all-clear for the oblast could arrive while their own raion was still
 * under warning. The oblast is still tracked, because it is what the reader falls back
 * to when their point sits outside every polygon (Kyiv city), and because a warning
 * covering every raion of an oblast is genuinely oblast-wide and should say so.
 *
 * Only transitions are messaged. The last known state is persisted per raion, so a
 * redeploy during an active alert does not re-announce it to everyone — which is
 * exactly the kind of noise that gets an alerting bot muted.
 */
export class AlertWatcher {
  private readonly users: Users;
  private readonly api: TelegramApi | undefined;
  private readonly opts: AlertWatcherOptions;
  private readonly selectState;
  private readonly upsertState;
  private readonly selectRaionState;
  private readonly upsertRaionState;
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;
  private running = false;

  constructor(db: Db, users: Users, api: TelegramApi | undefined, opts: AlertWatcherOptions) {
    this.users = users;
    this.api = api;
    this.opts = opts;

    this.selectState = db.prepare(`SELECT oblast, level FROM oblast_alerts`);
    this.selectRaionState = db.prepare(`SELECT raion, active FROM raion_alerts`);
    this.upsertRaionState = db.prepare(`
      INSERT INTO raion_alerts (raion, oblast, active, changed_at, updated_at)
      VALUES (@raion, @oblast, @active, @now, @now)
      ON CONFLICT(raion) DO UPDATE SET
        active = @active,
        changed_at = CASE WHEN raion_alerts.active <> @active THEN @now ELSE raion_alerts.changed_at END,
        updated_at = @now
    `);
    this.upsertState = db.prepare(`
      INSERT INTO oblast_alerts (oblast, active, level, areas, changed_at, updated_at)
      VALUES (@oblast, @active, @level, @areas, @now, @now)
      ON CONFLICT(oblast) DO UPDATE SET
        active = @active,
        level = @level,
        areas = @areas,
        changed_at = CASE WHEN oblast_alerts.level <> @level THEN @now ELSE oblast_alerts.changed_at END,
        updated_at = @now
    `);
  }

  start(): void {
    this.schedule(10_000);
    logger.info({ provider: this.opts.provider }, 'alert watcher started');
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
      const state = await fetchAlertState(this.opts.provider, this.opts.token, this.opts.timeoutMs);
      if (state.levels.size === 0) return { starts: [], stops: [], sent: 0 };

      const previousOblast = new Map<string, AlertLevel>(
        (this.selectState.all() as { oblast: string; level: string }[]).map((r) => [
          r.oblast,
          r.level as AlertLevel,
        ]),
      );
      const previousRaion = new Map<string, boolean>(
        (this.selectRaionState.all() as { raion: string; active: number }[]).map((r) => [
          r.raion,
          r.active === 1,
        ]),
      );

      /** Raion keys whose warning just began / just ended. */
      const starts: string[] = [];
      const stops: string[] = [];
      /** Oblast keys, for the readers whose point sits outside every polygon. */
      const oblastStarts: string[] = [];
      const oblastStops: string[] = [];

      for (const [oblast, level] of state.levels) {
        this.upsertState.run({
          oblast,
          active: isActive(level) ? 1 : 0,
          level,
          areas: JSON.stringify(state.areas.get(oblast) ?? []),
          now,
        });

        const beforeOblast = previousOblast.get(oblast);
        if (beforeOblast !== undefined && beforeOblast !== level) {
          if (!isActive(beforeOblast) && isActive(level)) oblastStarts.push(oblast);
          else if (isActive(beforeOblast) && !isActive(level)) oblastStops.push(oblast);
        }

        for (const raion of raionStates(oblast, level, state.areas.get(oblast) ?? [])) {
          const before = previousRaion.get(raion.match);
          this.upsertRaionState.run({
            raion: raion.match,
            oblast,
            active: raion.active ? 1 : 0,
            now,
          });

          /*
           * A raion seen for the first time is recorded but never announced. On a
           * fresh database — or the first poll after this feature shipped — every
           * active alert in the country would otherwise look like it had just started,
           * and everyone's phone would go off at once for nothing.
           */
          if (before === undefined || before === raion.active) continue;
          if (raion.active) starts.push(raion.match);
          else stops.push(raion.match);
        }
      }

      if (starts.length === 0 && stops.length === 0
        && oblastStarts.length === 0 && oblastStops.length === 0) {
        return { starts, stops, sent: 0 };
      }

      if (!this.api) {
        logger.info({ starts, stops }, 'alert transitions (no bot configured)');
        return { starts, stops, sent: 0 };
      }

      let sent = 0;
      for (const user of this.users.notifiable()) {
        const text = messageFor(user, { starts, stops, oblastStarts, oblastStops });
        if (text && await trySend(this.api, user.chat_id, text)) sent++;
      }

      logger.info({ starts, stops, sent }, 'alert transitions');
      return { starts, stops, sent };
    } finally {
      this.running = false;
    }
  }

}

/**
 * The alert state of every raion of an oblast.
 *
 * The feed names the warned areas, but not every named area is a raion — a hromada or
 * a city has no polygon and no key here. When *nothing* named resolves to a raion the
 * warning is still real, so the whole oblast is treated as warned rather than silently
 * dropped. It errs toward telling someone rather than not, which is the right way for
 * this particular error to fall.
 */
export function raionStates(
  oblast: string,
  level: AlertLevel,
  areas: string[],
): { match: string; active: boolean }[] {
  const raions = raionsOf(oblast);
  if (raions.length === 0) return [];

  if (!isActive(level)) return raions.map((r) => ({ match: r.match, active: false }));

  const warned = new Set(raions.filter((r) => areas.includes(r.match)).map((r) => r.match));
  if (warned.size === 0) return raions.map((r) => ({ match: r.match, active: true }));

  return raions.map((r) => ({ match: r.match, active: warned.has(r.match) }));
}

export interface AlertChanges {
  starts: string[];
  stops: string[];
  oblastStarts: string[];
  oblastStops: string[];
}

/**
 * What this reader should be told, if anything.
 *
 * Their own raion decides. Only when the bot could not place them in one — Kyiv city,
 * or a point just off the coast — does it fall back to their oblast, which is the
 * behaviour this replaced and is still the right answer for a city that is its own
 * administrative unit.
 */
export function messageFor(
  user: { oblast: string | null; raion: string | null },
  changes: AlertChanges,
): string | undefined {
  if (user.raion) {
    if (changes.starts.includes(user.raion)) {
      return `🚨 Повітряна тривога — ${raionName(user.raion)}`;
    }
    if (changes.stops.includes(user.raion)) {
      return `✅ Відбій тривоги — ${raionName(user.raion)}`;
    }
    return undefined;
  }

  if (!user.oblast) return undefined;
  const name = oblastByKey(user.oblast)?.name ?? user.oblast;
  if (changes.oblastStarts.includes(user.oblast)) return `🚨 Повітряна тривога — ${name} обл.`;
  if (changes.oblastStops.includes(user.oblast)) return `✅ Відбій тривоги — ${name} обл.`;
  return undefined;
}
