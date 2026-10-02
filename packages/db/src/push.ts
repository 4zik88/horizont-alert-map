import type { Sql } from './sql.js';

/**
 * Web Push subscriptions: the second warning channel.
 *
 * A subscription belongs to the user whose map session created it. Warnings are
 * decided from the location the user shared with the bot, exactly as for Telegram —
 * the browser's own location never leaves the device — so a subscription only ever
 * receives what the Telegram DM would have said.
 */
export interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** A user may have several browsers; past this many the oldest are dropped. */
export const MAX_SUBSCRIPTIONS_PER_USER = 10;

export async function savePushSubscription(
  sql: Sql,
  chatId: number,
  sub: PushSubscriptionRow,
  now = Date.now(),
): Promise<void> {
  await sql.transaction(async (tx) => {
    // An endpoint moves with the browser: if another session registered it, it now
    // belongs to whoever is logged in there.
    await tx.query(
      `INSERT INTO push_subscriptions (endpoint, chat_id, p256dh, auth, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE
         SET chat_id = excluded.chat_id, p256dh = excluded.p256dh, auth = excluded.auth,
             created_at = excluded.created_at`,
      [sub.endpoint, chatId, sub.p256dh, sub.auth, now],
    );
    await tx.query(
      `DELETE FROM push_subscriptions WHERE chat_id = $1 AND endpoint NOT IN (
         SELECT endpoint FROM push_subscriptions WHERE chat_id = $1
          ORDER BY created_at DESC LIMIT $2)`,
      [chatId, MAX_SUBSCRIPTIONS_PER_USER],
    );
  });
}

export async function deletePushSubscription(sql: Sql, chatId: number, endpoint: string): Promise<boolean> {
  const r = await sql.query('DELETE FROM push_subscriptions WHERE chat_id = $1 AND endpoint = $2', [chatId, endpoint]);
  return r.rowCount > 0;
}

/** The push service said this endpoint is gone (404/410): forget it for everyone. */
export async function forgetPushEndpoint(sql: Sql, endpoint: string): Promise<void> {
  await sql.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
}

export async function pushSubscriptionsOf(sql: Sql, chatId: number): Promise<PushSubscriptionRow[]> {
  const { rows } = await sql.query<PushSubscriptionRow>(
    'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE chat_id = $1 ORDER BY created_at DESC',
    [chatId],
  );
  return rows;
}

export async function countPushSubscriptions(sql: Sql, chatId: number): Promise<number> {
  const { rows } = await sql.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM push_subscriptions WHERE chat_id = $1',
    [chatId],
  );
  return rows[0]?.n ?? 0;
}
