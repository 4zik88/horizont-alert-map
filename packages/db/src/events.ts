import type { DomainEvent } from '@horizont/contract';
import type { Sql } from './sql.js';

export const EVENTS_CHANNEL = 'events';

/**
 * Append to the realtime log. Call inside the transaction that made the change, so a
 * client never sees an event for a row that was rolled back. NOTIFY is transactional
 * too: it is delivered on commit, carrying the new seq.
 */
export async function appendEvent(tx: Sql, e: DomainEvent, at = Date.now()): Promise<number> {
  const { rows } = await tx.query<{ seq: number }>(
    'INSERT INTO events (at, type, payload) VALUES ($1, $2, $3) RETURNING seq',
    [at, e.type, JSON.stringify(e)],
  );
  const seq = rows[0]!.seq;
  await tx.query('SELECT pg_notify($1, $2)', [EVENTS_CHANNEL, String(seq)]);
  return seq;
}

export interface StoredEvent {
  seq: number;
  at: number;
  e: DomainEvent;
}

/** Events after `seq`, oldest first. */
export async function eventsAfter(sql: Sql, seq: number, limit = 1000): Promise<StoredEvent[]> {
  const { rows } = await sql.query<{ seq: number; at: number; payload: DomainEvent | string }>(
    'SELECT seq, at, payload FROM events WHERE seq > $1 ORDER BY seq LIMIT $2',
    [seq, limit],
  );
  return rows.map((r) => ({
    seq: r.seq,
    at: r.at,
    e: typeof r.payload === 'string' ? (JSON.parse(r.payload) as DomainEvent) : r.payload,
  }));
}

/** Oldest seq still held, or null when the log is empty. */
export async function oldestSeq(sql: Sql): Promise<number | null> {
  const { rows } = await sql.query<{ seq: number | null }>('SELECT min(seq) AS seq FROM events');
  return rows[0]?.seq ?? null;
}

export async function latestSeq(sql: Sql): Promise<number> {
  const { rows } = await sql.query<{ seq: number | null }>('SELECT max(seq) AS seq FROM events');
  return rows[0]?.seq ?? 0;
}

export async function pruneEvents(sql: Sql, olderThanMs = 6 * 3_600_000, now = Date.now()): Promise<number> {
  return (await sql.query('DELETE FROM events WHERE at < $1', [now - olderThanMs])).rowCount;
}
