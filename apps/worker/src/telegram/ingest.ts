import { createHash } from 'node:crypto';
import type { Repo } from '../db/repo.js';
import { isSensitive } from '@horizont/parser';
import type { IngestResult, ParsedMessage } from '../types.js';

/**
 * Writes a page of extracted messages to the database.
 *
 * Kept separate from the poller on purpose: the poller owns *when* to fetch, this owns
 * *what lands in the DB*. The backfill script and step 2's re-parse worker reuse it
 * without touching the loop.
 *
 * The whole page goes in one transaction — ~20 statements — so a crash mid-page can
 * never leave a half-ingested cursor.
 */
export async function ingestMessages(
  repo: Repo,
  messages: ParsedMessage[],
  now: number = Date.now(),
): Promise<IngestResult> {
  if (messages.length === 0) {
    return { inserted: 0, updated: 0, minId: null, maxId: null };
  }

  return repo.transaction(async (tx) => {
    let inserted = 0;
    let updated = 0;
    let minId = Number.POSITIVE_INFINITY;
    let maxId = 0;

    for (const message of messages) {
      const params = {
        channel: message.channel,
        messageId: message.messageId,
        postedAt: message.postedAt,
        fetchedAt: now,
        text: message.text,
        textHtml: message.textHtml,
        contentHash: hashText(message.text),
        hasMedia: message.hasMedia ? 1 : 0,
        isSensitive: isSensitive(message.text) ? 1 : 0,
      };

      if (await tx.tryInsertMessage(params)) {
        inserted += 1;
      } else if (await tx.tryUpdateMessage(params)) {
        // Already seen, but the text changed: an edit. @KozakChornobay revises posts
        // continuously as a target moves, so this is a routine path.
        updated += 1;
      }

      if (message.messageId < minId) minId = message.messageId;
      if (message.messageId > maxId) maxId = message.messageId;
    }

    return { inserted, updated, minId, maxId };
  });
}

export function hashText(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}
