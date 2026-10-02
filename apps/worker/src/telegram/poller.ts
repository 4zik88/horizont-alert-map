import { setTimeout as delay } from 'node:timers/promises';
import type { Repo } from '../db/repo.js';
import { logger } from '../logger.js';
import { FetchError } from '../types.js';
import { fetchChannelPage } from './fetchPage.js';
import { ingestMessages } from './ingest.js';
import { parsePage } from '@horizont/parser';
import { failureLogLevel, gapFillAdvanced, needsGapFill, nextDelay } from './policy.js';

export interface PollerOptions {
  channels: string[];
  pollIntervalMs: number;
  jitterPct: number;
  fetchTimeoutMs: number;
  maxBackoffMs: number;
  gapFillMaxPages: number;
}

const GAP_FILL_PAUSE_MS = 800;

export class Poller {
  private stopping = false;
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly running = new Set<Promise<void>>();

  private readonly repo: Repo;
  private readonly opts: PollerOptions;

  constructor(repo: Repo, opts: PollerOptions) {
    this.repo = repo;
    this.opts = opts;
  }

  start(): void {
    this.opts.channels.forEach((channel, index) => {
      this.repo.ensureChannel(channel.toLowerCase());
      // Stagger the channels so three full-page fetches never fire together.
      this.schedule(channel.toLowerCase(), index * 2_500);
    });

    logger.info(
      { channels: this.opts.channels, intervalMs: this.opts.pollIntervalMs },
      'poller started',
    );
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    // better-sqlite3 transactions are synchronous, so an in-flight ingest is already
    // atomic; this only waits for the surrounding fetch to settle.
    await Promise.allSettled([...this.running]);
    logger.info('poller stopped');
  }

  private schedule(channel: string, ms: number): void {
    if (this.stopping) return;

    const timer = setTimeout(() => {
      this.timers.delete(timer);
      const task = this.runCycle(channel).finally(() => this.running.delete(task));
      this.running.add(task);
    }, ms);

    this.timers.add(timer);
  }

  private async runCycle(channel: string): Promise<void> {
    if (this.stopping) return;

    const startedAt = Date.now();

    try {
      const state = this.repo.getChannel(channel);
      if (state && state.enabled === 0) {
        logger.debug({ channel }, 'channel disabled, skipping');
        this.schedule(channel, this.opts.pollIntervalMs);
        return;
      }

      const html = await fetchChannelPage(channel, {}, this.opts.fetchTimeoutMs);
      const messages = parsePage(html, channel);

      // A 200 with nothing parsed is how both markup drift and soft-blocking present.
      // Treating it as success would let the poller fail silently forever.
      if (messages.length === 0) {
        throw new FetchError('empty', `channel ${channel} returned a page with no messages`);
      }

      const result = ingestMessages(this.repo, messages);
      const minId = result.minId ?? 0;
      const maxId = result.maxId ?? 0;

      let gapFilled = 0;
      if (state && needsGapFill(state.lastMessageId, minId)) {
        gapFilled = await this.gapFill(channel, state.lastMessageId, minId);
      }

      this.repo.markSuccess(channel, minId, maxId, Date.now());

      const payload = {
        channel,
        fetched: messages.length,
        inserted: result.inserted,
        updated: result.updated,
        gapFilled,
        maxId,
        ms: Date.now() - startedAt,
      };

      // Only log a cycle that changed something. At 3 channels x 3/min, logging every
      // cycle would bury the real events under ~4300 useless lines a day.
      if (result.inserted + result.updated + gapFilled > 0) {
        logger.info(payload, 'poll');
      } else {
        logger.debug(payload, 'poll (no change)');
      }

      for (const message of messages) {
        // Public channel content, so safe to log; kept at debug for volume, and it is
        // how the step-2 parser gets debugged against real traffic.
        logger.debug({ channel, messageId: message.messageId, text: message.text }, 'message');
      }

      this.schedule(channel, nextDelay(0, this.delayOpts()));
    } catch (error) {
      this.handleFailure(channel, error);
    }
  }

  /**
   * Walks `?after=` forward until it stops making progress. Used after downtime or a
   * redeploy — the visible page only shows the newest 20 posts, so anything older that
   * we missed has to be pulled explicitly.
   */
  private async gapFill(channel: string, from: number, minIdOnPage: number): Promise<number> {
    let cursor = from;
    let pages = 0;
    let ingested = 0;

    while (pages < this.opts.gapFillMaxPages && cursor < minIdOnPage && !this.stopping) {
      const html = await fetchChannelPage(channel, { after: cursor }, this.opts.fetchTimeoutMs);
      const messages = parsePage(html, channel);
      const result = ingestMessages(this.repo, messages);

      ingested += result.inserted + result.updated;
      pages += 1;

      // "No id newer than the cursor" is the only safe stop condition — deleted posts
      // leave holes, so waiting for contiguity would loop forever.
      if (!gapFillAdvanced(cursor, result.maxId)) break;
      cursor = result.maxId as number;

      await delay(GAP_FILL_PAUSE_MS);
    }

    logger.info({ channel, from, to: cursor, pages, ingested }, 'gap fill');
    return ingested;
  }

  private handleFailure(channel: string, error: unknown): void {
    const fetchError = error instanceof FetchError ? error : undefined;
    const message = error instanceof Error ? error.message : String(error);

    this.repo.markFailure(channel, message, Date.now());
    const failures = this.repo.getChannel(channel)?.consecutiveFailures ?? 1;

    if (fetchError?.permanent) {
      // A redirect will not stop being a redirect. Keep retrying at the capped
      // backoff rather than spinning, but say clearly that it needs a human.
      logger.error(
        { channel, kind: fetchError.kind, status: fetchError.status },
        'channel looks gone or private — check the name in CHANNELS',
      );
      this.schedule(channel, this.opts.maxBackoffMs);
      return;
    }

    const wait = Math.max(
      fetchError?.retryAfterMs ?? 0,
      nextDelay(failures, this.delayOpts()),
    );

    logger[failureLogLevel(failures)](
      {
        channel,
        kind: fetchError?.kind ?? 'unknown',
        status: fetchError?.status,
        attempt: failures,
        nextDelayMs: wait,
        reason: message,
      },
      'poll failed',
    );

    this.schedule(channel, wait);
  }

  private delayOpts() {
    return {
      baseMs: this.opts.pollIntervalMs,
      jitterPct: this.opts.jitterPct,
      maxBackoffMs: this.opts.maxBackoffMs,
    };
  }
}
