import type { Db } from '../db/index.js';
import { logger } from '../logger.js';

/**
 * Message retention.
 *
 * The ingest log grows forever otherwise — roughly 1,500 messages a week from four
 * channels, each with its raw HTML. Nothing reads a message older than the notifier's
 * window, and the parser corpus is a development concern rather than a production one.
 *
 * `targets` has `ON DELETE CASCADE` from `messages`, so deleting a message removes
 * everything derived from it in one statement. `foreign_keys = ON` is set on every
 * connection, which is what makes that true — without it the cascade silently does
 * nothing and orphans accumulate.
 */
export function pruneMessages(db: Db, olderThanMs: number, now = Date.now()): number {
  const cutoff = now - olderThanMs;
  const removed = db.prepare('DELETE FROM messages WHERE posted_at < ?').run(cutoff).changes;

  if (removed > 0) {
    logger.info({ removed, olderThanDays: Math.round(olderThanMs / 86_400_000) }, 'messages pruned');
  }
  return removed;
}

/**
 * How long a delivered warning is remembered.
 *
 * Only long enough to answer "have I already said this?" — a day covers the longest
 * repeat window many times over. The old ledger was keyed on a target id and cascaded
 * away with the message; the subject-keyed one has no such anchor, so it is pruned by
 * age instead, and without this it would grow for the life of the volume.
 */
const LEDGER_KEEP_MS = 24 * 60 * 60_000;

export function pruneNoticeLedger(db: Db, now = Date.now()): number {
  const removed = db
    .prepare('DELETE FROM notice_ledger WHERE sent_at < ?')
    .run(now - LEDGER_KEEP_MS).changes;

  if (removed > 0) logger.info({ removed }, 'notice ledger pruned');
  return removed;
}
