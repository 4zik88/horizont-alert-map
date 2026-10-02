/**
 * One-off historical backfill: walks `?before=` to pull roughly PAGES*20 messages per
 * channel. Seeds the database and, more importantly, builds a realistic corpus to
 * develop and regression-test the step-2 parser against.
 *
 * Safe to re-run — ingest is idempotent.
 *
 *   npm run backfill              # ~500 per channel
 *   BACKFILL_PAGES=50 npm run backfill
 */
import { config } from '../src/config.js';
import { closeDb, openDb } from '../src/db/index.js';
import { Repo } from '../src/db/repo.js';
import { logger } from '../src/logger.js';
import { fetchChannelPage } from '../src/telegram/fetchPage.js';
import { ingestMessages } from '../src/telegram/ingest.js';
import { parsePage } from '@horizont/parser';

const PAGES = Number.parseInt(process.env['BACKFILL_PAGES'] ?? '25', 10);
const PAUSE_MS = 900;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function backfillChannel(repo: Repo, channel: string): Promise<void> {
  repo.ensureChannel(channel);

  let cursor: number | undefined;
  let total = 0;

  for (let page = 0; page < PAGES; page++) {
    const html = await fetchChannelPage(
      channel,
      cursor === undefined ? {} : { before: cursor },
      config.FETCH_TIMEOUT_MS,
    );
    const messages = parsePage(html, channel);
    if (messages.length === 0) {
      logger.info({ channel, page }, 'backfill reached the end of available history');
      break;
    }

    const result = ingestMessages(repo, messages);
    total += result.inserted;
    const minId = result.minId as number;
    const maxId = result.maxId as number;

    repo.markSuccess(channel, minId, maxId, Date.now());
    logger.info(
      { channel, page: page + 1, minId, maxId, inserted: result.inserted, total },
      'backfill page',
    );

    // Walking backwards: the next page starts below the lowest id we just saw.
    if (cursor !== undefined && minId >= cursor) break;
    cursor = minId;

    await sleep(PAUSE_MS);
  }

  logger.info({ channel, inserted: total }, 'backfill complete');
}

async function main(): Promise<void> {
  const db = openDb(config.DB_PATH);
  const repo = new Repo(db);

  try {
    for (const channel of config.CHANNELS) {
      await backfillChannel(repo, channel.toLowerCase());
    }
  } finally {
    closeDb(db);
  }
}

void main();
