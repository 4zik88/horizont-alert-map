import { issueLogin, revokeAccess, type Sql } from '@horizont/db';
import { escapeHtml } from '../bot/format.js';
import { isAllowed } from '../bot/access.js';
import { logger } from '../logger.js';

/**
 * The bot's map login message: a one-time link, and the same grant as a typed code
 * for an installed iOS app, whose cookie jar a link opened in Safari never reaches.
 * Both expire in 10 minutes and die together on first use.
 */
export function mapLoginMessage(sql: Sql, publicUrl: string): (chatId: number) => Promise<string> {
  const base = publicUrl.replace(/\/+$/, '');
  return async (chatId) => {
    const { token, code } = await issueLogin(sql, chatId);
    const link = `${base}/auth?t=${encodeURIComponent(token)}`;
    return [
      '🗺 <b>Карта</b>',
      `<a href="${escapeHtml(link)}">Увійти на карту</a>`,
      `Або введіть код у застосунку: <code>${code}</code>`,
      'Діє 10 хвилин, лише один раз. Нікому не пересилайте.',
    ].join('\n');
  };
}

/** End map sessions of anyone who has been taken off the allowlist. */
export async function revokeRemovedUsers(sql: Sql): Promise<void> {
  const { rows } = await sql.query<{ chat_id: number; username: string | null }>(
    'SELECT DISTINCT u.chat_id, u.username FROM users u JOIN sessions s ON s.chat_id = u.chat_id',
  );
  const removed = rows
    .filter((r) => !isAllowed({ chatId: r.chat_id, username: r.username ?? undefined }))
    .map((r) => r.chat_id);
  const ended = await revokeAccess(sql, removed);
  if (ended > 0) logger.info({ sessions: ended }, 'map sessions ended for users no longer allowed');
}
