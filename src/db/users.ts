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
  is_active: number;
}

export const DEFAULT_RADIUS_KM = 40;
export const MIN_RADIUS_KM = 5;
export const MAX_RADIUS_KM = 200;

export class Users {
  private readonly db: Db;
  private readonly selectByChat;
  private readonly upsert;
  private readonly setLocation;
  private readonly setRadius;
  private readonly setActive;
  private readonly selectNotifiable;

  constructor(db: Db) {
    this.db = db;

    this.selectByChat = db.prepare(`SELECT * FROM users WHERE chat_id = ?`);

    this.upsert = db.prepare(`
      INSERT INTO users (chat_id, username, radius_km, is_active, created_at, updated_at)
      VALUES (@chatId, @username, @radius, 1, @now, @now)
      ON CONFLICT(chat_id) DO UPDATE SET
        username = COALESCE(excluded.username, users.username),
        is_active = 1,
        updated_at = @now
    `);

    this.setLocation = db.prepare(`
      UPDATE users
         SET lat = @lat, lon = @lon, location_kind = @kind, oblast = @oblast,
             location_updated_at = @now, live_until = @liveUntil, updated_at = @now
       WHERE chat_id = @chatId
    `);

    this.setRadius = db.prepare(
      `UPDATE users SET radius_km = @radius, updated_at = @now WHERE chat_id = @chatId`,
    );

    this.setActive = db.prepare(
      `UPDATE users SET is_active = @active, updated_at = @now WHERE chat_id = @chatId`,
    );

    // Only users who can actually be placed on the map are notifiable.
    this.selectNotifiable = db.prepare(`
      SELECT * FROM users
       WHERE is_active = 1 AND lat IS NOT NULL AND lon IS NOT NULL
    `);
  }

  get(chatId: number): UserRow | undefined {
    return this.selectByChat.get(chatId) as UserRow | undefined;
  }

  /** Called on /start. Re-activates a user who had stopped, keeping their settings. */
  register(chatId: number, username: string | undefined, now: number): void {
    this.upsert.run({ chatId, username: username ?? null, radius: DEFAULT_RADIUS_KM, now });
  }

  saveLocation(params: {
    chatId: number;
    lat: number;
    lon: number;
    kind: 'static' | 'live';
    oblast: string | null;
    liveUntil: number | null;
    now: number;
  }): void {
    this.setLocation.run(params);
  }

  updateRadius(chatId: number, radiusKm: number, now: number): void {
    this.setRadius.run({ chatId, radius: radiusKm, now });
  }

  setStopped(chatId: number, now: number): void {
    this.setActive.run({ chatId, active: 0, now });
  }

  notifiable(): UserRow[] {
    return this.selectNotifiable.all() as UserRow[];
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}

/** Small durable key/value, used for the Telegram offset and the notifier cursor. */
export class AppState {
  private readonly get_;
  private readonly set_;

  constructor(db: Db) {
    this.get_ = db.prepare(`SELECT value FROM app_state WHERE key = ?`);
    this.set_ = db.prepare(`
      INSERT INTO app_state (key, value, updated_at) VALUES (@key, @value, @now)
      ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = @now
    `);
  }

  getNumber(key: string, fallback: number): number {
    const row = this.get_.get(key) as { value: string } | undefined;
    if (!row) return fallback;
    const parsed = Number.parseInt(row.value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  setNumber(key: string, value: number, now: number): void {
    this.set_.run({ key, value: String(value), now });
  }
}
