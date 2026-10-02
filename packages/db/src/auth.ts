import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { Sql } from './sql.js';

/**
 * Map access: a one-time login issued by the bot, then a cookie session.
 *
 * Only SHA-256 hashes are stored. A raw token exists only in the user's Telegram DM; a
 * raw session id only in their cookie. A leaked database grants nothing.
 */

export const LOGIN_TTL_MS = 10 * 60_000;
export const SESSION_TTL_MS = 90 * 86_400_000;
/** Sliding expiry is written at most this often, not on every request. */
const SESSION_TOUCH_MS = 60 * 60_000;

/** No I/O/0/1: a code is read off a phone and typed into another field. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Uppercase, and drop the dash and any spaces people type or paste with it. */
export function normaliseCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function newCode(): string {
  let code = '';
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** Issue a login for a registered user. Returns the secrets to put in the DM. */
export async function issueLogin(
  sql: Sql,
  chatId: number,
  now = Date.now(),
): Promise<{ token: string; code: string; expiresAt: number }> {
  const token = randomBytes(32).toString('base64url');
  const code = newCode();
  const expiresAt = now + LOGIN_TTL_MS;
  await sql.transaction(async (tx) => {
    // One live login per user: a new /start voids the previous link and code.
    await tx.query('DELETE FROM login_tokens WHERE chat_id = $1 AND used_at IS NULL', [chatId]);
    await tx.query(
      `INSERT INTO login_tokens (token_hash, code_hash, chat_id, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [sha256(token), sha256(normaliseCode(code)), chatId, now, expiresAt],
    );
  });
  return { token, code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt };
}

/** Spend a login, by link token or typed code. Returns the user, or null. */
export async function consumeLogin(
  sql: Sql,
  secret: { token: string } | { code: string },
  now = Date.now(),
): Promise<number | null> {
  const [column, value] = 'token' in secret
    ? ['token_hash', sha256(secret.token)]
    : ['code_hash', sha256(normaliseCode(secret.code))];
  const { rows } = await sql.query<{ chat_id: number }>(
    `UPDATE login_tokens l SET used_at = $2
       FROM users u
      WHERE l.${column} = $1 AND l.used_at IS NULL AND l.expires_at > $2
        AND u.chat_id = l.chat_id
      RETURNING l.chat_id`,
    [value, now],
  );
  return rows[0]?.chat_id ?? null;
}

export async function createSession(sql: Sql, chatId: number, now = Date.now()): Promise<string> {
  const id = randomBytes(32).toString('base64url');
  await sql.query(
    `INSERT INTO sessions (id_hash, chat_id, created_at, last_seen_at, expires_at)
     VALUES ($1, $2, $3, $3, $4)`,
    [sha256(id), chatId, now, now + SESSION_TTL_MS],
  );
  return id;
}

export interface SessionUser {
  chatId: number;
  username: string | null;
  oblast: string | null;
}

/** The user behind a session cookie, extending it while in use. */
export async function sessionUser(sql: Sql, sessionId: string, now = Date.now()): Promise<SessionUser | null> {
  const hash = sha256(sessionId);
  const { rows } = await sql.query<{
    chat_id: number; username: string | null; oblast: string | null; last_seen_at: number;
  }>(
    `SELECT s.chat_id, u.username, u.oblast, s.last_seen_at
       FROM sessions s JOIN users u ON u.chat_id = s.chat_id
      WHERE s.id_hash = $1 AND s.expires_at > $2`,
    [hash, now],
  );
  const row = rows[0];
  if (!row) return null;
  if (now - row.last_seen_at > SESSION_TOUCH_MS) {
    await sql.query('UPDATE sessions SET last_seen_at = $2, expires_at = $3 WHERE id_hash = $1', [
      hash, now, now + SESSION_TTL_MS,
    ]);
  }
  return { chatId: row.chat_id, username: row.username, oblast: row.oblast };
}

export async function deleteSession(sql: Sql, sessionId: string): Promise<void> {
  await sql.query('DELETE FROM sessions WHERE id_hash = $1', [sha256(sessionId)]);
}

/**
 * Map access follows the bot's allowlist, which lives in the worker's environment.
 * The worker calls this at boot with every user who is no longer allowed, so removing
 * someone from the list also ends their map sessions and pending logins.
 */
export async function revokeAccess(sql: Sql, chatIds: number[]): Promise<number> {
  if (chatIds.length === 0) return 0;
  await sql.query('DELETE FROM login_tokens WHERE chat_id = ANY($1::bigint[])', [chatIds]);
  return (await sql.query('DELETE FROM sessions WHERE chat_id = ANY($1::bigint[])', [chatIds])).rowCount;
}

export async function pruneAuth(sql: Sql, now = Date.now()): Promise<void> {
  await sql.query('DELETE FROM login_tokens WHERE expires_at < $1', [now - 86_400_000]);
  await sql.query('DELETE FROM sessions WHERE expires_at < $1', [now]);
}
