import type { Db } from '../db/index.js';
import { logger } from '../logger.js';

/**
 * Message retention.
 *
 * The ingest log grows forever otherwise — roughly 1,500 messages a week from four
 * channels, each with its raw HTML. Nothing reads a message older than the feed
 * window, and the parser corpus is a development concern rather than a production
 * one.
 *
 * `targets` has `ON DELETE CASCADE` from `messages`, and `notifications` cascades
 * from `targets`, so deleting a message removes everything derived from it in one
 * statement. `foreign_keys = ON` is set on every connection, which is what makes
 * that true — without it the cascade silently does nothing and orphans accumulate.
 */
export function pruneMessages(db: Db, olderThanMs: number, now = Date.now()): number {
  const cutoff = now - olderThanMs;
  const removed = db.prepare('DELETE FROM messages WHERE posted_at < ?').run(cutoff).changes;

  if (removed > 0) {
    logger.info({ removed, olderThanDays: Math.round(olderThanMs / 86_400_000) }, 'messages pruned');
  }
  return removed;
}
