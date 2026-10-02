import { publishMessage, syncAlerts, trackIdsOfMessage, type Sql } from '@horizont/db';
import { TYPE_SPEED_KMH, type TargetType } from '@horizont/parser';
import type { AlertState } from '../alerts/client.js';
import { logger } from '../logger.js';
import { desiredAlerts } from './alerts.js';

/**
 * The worker's side of the map: after a message is parsed its targets join tracks,
 * and after an alert poll the intervals follow the feed. Both write the event log the
 * API streams to open maps.
 *
 * Map publishing is a reader-facing extra on top of the warnings. A failure here is
 * logged and never stops parsing or a Telegram warning.
 */
export interface MapPublisher {
  /** Tracks the message fed before it is re-saved, so an edit can retract them. */
  beforeSave(messageId: number): Promise<number[]>;
  afterSave(messageId: number, previousTrackIds: number[]): Promise<void>;
}

const speedKmh = (type: string) => TYPE_SPEED_KMH[type as TargetType] ?? 200;

export function mapPublisher(sql: Sql): MapPublisher {
  return {
    async beforeSave(messageId) {
      try {
        return await trackIdsOfMessage(sql, messageId);
      } catch (err) {
        logger.warn({ messageId, err: String(err) }, 'map: could not read previous tracks');
        return [];
      }
    },
    async afterSave(messageId, previousTrackIds) {
      try {
        await publishMessage(sql, messageId, { speedKmh, previousTrackIds });
      } catch (err) {
        logger.warn({ messageId, err: String(err) }, 'map: publishing targets failed');
      }
    },
  };
}

/** Bring the map's alert intervals in line with a poll the watcher accepted. */
export async function publishAlerts(sql: Sql, state: AlertState, now: number): Promise<void> {
  try {
    const { started, ended } = await syncAlerts(sql, desiredAlerts(state.levels, state.areas), now);
    if (started + ended > 0) logger.info({ started, ended }, 'map: alert intervals updated');
  } catch (err) {
    logger.warn({ err: String(err) }, 'map: publishing alerts failed');
  }
}
