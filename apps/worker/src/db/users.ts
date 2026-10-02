import type { Db } from './index.js';

/**
 * User storage.
 *
 * Coordinates live here and nowhere else: never in a log line, never in an error,
 * never sent to any external service. `src/logger.ts` redacts lat/lon/chat_id paths
 * so an accidental `log.info({ user })` cannot leak them.
 */
export interface UserRow {
  id: number;
  chat_id: number;
  username: string | null;
  lat: number | null;
  lon: number | null;
  location_kind: 'static' | 'live' | null;
  location_updated_at: number | null;
  live_until: number | null;
  radius_km: number;
  oblast: string | null;
  /** Raion key matching the alert feed's area names; null outside every polygon. */
  raion: string | null;
  is_active: number;
}

export const DEFAULT_RADIUS_KM = 40;
export const MIN_RADIUS_KM = 5;
export const MAX_RADIUS_KM = 200;

export class Users {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async get(chatId: number): Promise<UserRow | undefined> {
    const { rows } = await this.db.query<UserRow>(`SELECT * FROM users WHERE chat_id = $1`, [chatId]);
    return rows[0];
  }

  /** Called on /start. Re-activates a user who had stopped, keeping their settings. */
  async register(chatId: number, username: string | undefined, now: number): Promise<void> {
    await this.db.query(
      `INSERT INTO users (chat_id, username, radius_km, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, 1, $4, $4)
       ON CONFLICT (chat_id) DO UPDATE SET
         username = COALESCE(excluded.username, users.username),
         is_active = 1,
         updated_at = $4`,
      [chatId, username ?? null, DEFAULT_RADIUS_KM, now],
    );
  }

  /**
   * Make sure a row exists, without touching notifications. /map uses this: opening
   * the map must not switch warnings back on for someone who sent /stop.
   */
  async ensureKnown(chatId: number, username: string | undefined, now: number): Promise<void> {
    await this.db.query(
      `INSERT INTO users (chat_id, username, radius_km, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, 1, $4, $4)
       ON CONFLICT (chat_id) DO UPDATE SET
         username = COALESCE(excluded.username, users.username)`,
      [chatId, username ?? null, DEFAULT_RADIUS_KM, now],
    );
  }

  async saveLocation(p: {
    chatId: number;
    lat: number;
    lon: number;
    kind: 'static' | 'live';
    oblast: string | null;
    raion: string | null;
    liveUntil: number | null;
    now: number;
  }): Promise<void> {
    await this.db.query(
      `UPDATE users
          SET lat = $2, lon = $3, location_kind = $4, oblast = $5,
              raion = $6, location_updated_at = $7, live_until = $8,
              updated_at = $7
        WHERE chat_id = $1`,
      [p.chatId, p.lat, p.lon, p.kind, p.oblast, p.raion, p.now, p.liveUntil],
    );
  }

  /**
   * Fill in the raion for users who shared a location before raions existed.
   *
   * Without this they keep a null raion until they next send a location, and a null
   * raion silently falls back to oblast-level alerts — the exact behaviour this
   * replaced, for precisely the people already using the bot. Cheap enough to run at
   * every boot: it is one point-in-polygon per user with no raion, and a handful of
   * users.
   */
  async backfillRaions(locate: (lat: number, lon: number) => string | null, now: number): Promise<number> {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ chat_id: number; lat: number; lon: number }>(
        `SELECT chat_id, lat, lon FROM users WHERE raion IS NULL AND lat IS NOT NULL`,
      );

      let filled = 0;
      for (const row of rows) {
        const raion = locate(row.lat, row.lon);
        if (raion === null) continue;
        await tx.query(
          `UPDATE users SET raion = $2, updated_at = $3 WHERE chat_id = $1`,
          [row.chat_id, raion, now],
        );
        filled++;
      }
      return filled;
    });
  }

  async updateRadius(chatId: number, radiusKm: number, now: number): Promise<void> {
    await this.db.query(
      `UPDATE users SET radius_km = $2, updated_at = $3 WHERE chat_id = $1`,
      [chatId, radiusKm, now],
    );
  }

  async setStopped(chatId: number, now: number): Promise<void> {
    await this.db.query(
      `UPDATE users SET is_active = $2, updated_at = $3 WHERE chat_id = $1`,
      [chatId, 0, now],
    );
  }

  /** Only users who can actually be placed on the map are notifiable. */
  async notifiable(): Promise<UserRow[]> {
    // `id`: the order SQLite's table scan returned them in.
    const { rows } = await this.db.query<UserRow>(
      `SELECT * FROM users
        WHERE is_active = 1 AND lat IS NOT NULL AND lon IS NOT NULL
        ORDER BY id`,
    );
    return rows;
  }

  /** Run `fn` in one transaction, with a `Users` bound to it. */
  transaction<T>(fn: (users: Users) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => fn(new Users(tx)));
  }
}

/** Small durable key/value, used for the Telegram offset and the notifier cursor. */
export class AppState {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async getNumber(key: string, fallback: number): Promise<number> {
    const { rows } = await this.db.query<{ value: string }>(
      `SELECT value FROM app_state WHERE key = $1`,
      [key],
    );
    if (!rows[0]) return fallback;
    const parsed = Number.parseInt(rows[0].value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  async setNumber(key: string, value: number, now: number): Promise<void> {
    await this.db.query(
      `INSERT INTO app_state (key, value, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, String(value), now],
    );
  }
}
