import type { Db } from '../db/index.js';
import type { Repo, PendingMessage, TargetParams } from '../db/repo.js';
import { logger } from '../logger.js';
import { Gazetteer } from './gazetteer.js';
import { parseMessage } from './index.js';
import type { LlmExtractor } from './llm.js';
import type { ParsedTarget } from './rules.js';

/**
 * Bump to re-parse the entire archive after a parser change:
 *   UPDATE messages SET parse_state='pending' WHERE parser_version < <new>;
 */
export const PARSER_VERSION = 4;

export interface WorkerOptions {
  batchSize: number;
  intervalMs: number;
  /** Cap on LLM calls per batch, so a bad day cannot run up an unbounded bill. */
  llmBudgetPerBatch: number;
}

/**
 * Drains the `parse_state = 'pending'` queue: rules first, Claude only for what the
 * rules could not resolve, and anything still unresolved is left as `unparsed` so
 * the feed shows it as plain text with no map marker.
 */
export class ParseWorker {
  private readonly repo: Repo;
  private readonly gazetteer: Gazetteer;
  private readonly llm: LlmExtractor;
  private readonly opts: WorkerOptions;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopping = false;

  constructor(db: Db, repo: Repo, llm: LlmExtractor, opts: WorkerOptions) {
    this.repo = repo;
    this.gazetteer = new Gazetteer(db);
    this.llm = llm;
    this.opts = opts;
  }

  start(): void {
    this.schedule(1_000);
    logger.info({ batchSize: this.opts.batchSize }, 'parse worker started');
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    while (this.running) await new Promise((r) => setTimeout(r, 50));
    logger.info('parse worker stopped');
  }

  private schedule(ms: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  /**
   * One scheduled pass: run a batch, then decide when to run the next one. Kept
   * separate from `runBatch` so that running a batch has no scheduling side effect —
   * otherwise every caller (tests included) leaves a live timer behind.
   */
  private async tick(): Promise<void> {
    let drained = false;
    try {
      const result = await this.runBatch();
      drained = result.batch === this.opts.batchSize;
    } catch (error) {
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'parse batch failed',
      );
    }
    // Work a backlog down quickly; idle politely once caught up.
    this.schedule(drained ? 250 : this.opts.intervalMs);
  }

  /** Parse one batch of pending messages. No timers, no scheduling. */
  async runBatch(): Promise<{ batch: number; parsed: number; unparsed: number; targets: number; llmCalls: number }> {
    this.running = true;
    const started = Date.now();
    let parsed = 0;
    let unparsed = 0;
    let targetCount = 0;
    let llmCalls = 0;

    try {
      const skipped = this.repo.skipUnparseable(Date.now(), PARSER_VERSION);
      const batch = this.repo.pendingMessages(this.opts.batchSize);

      for (const message of batch) {
        const result = await this.parseOne(message, llmCalls < this.opts.llmBudgetPerBatch);
        if (result.usedLlm) llmCalls++;
        if (result.targets.length > 0) parsed++;
        else unparsed++;
        targetCount += result.targets.length;
      }

      if (batch.length > 0 || skipped > 0) {
        logger.info(
          { batch: batch.length, skipped, parsed, unparsed, targets: targetCount, llmCalls, ms: Date.now() - started },
          'parse batch',
        );
      }

      return { batch: batch.length, parsed, unparsed, targets: targetCount, llmCalls };
    } finally {
      this.running = false;
    }
  }

  private async parseOne(
    message: PendingMessage,
    llmAllowed: boolean,
  ): Promise<{ targets: ParsedTarget[]; usedLlm: boolean }> {
    const result = parseMessage(message.text, this.gazetteer);
    let targets = result.targets;
    let source = 'rules';
    let usedLlm = false;

    if (result.needsLlm && llmAllowed) {
      usedLlm = true;
      try {
        const fromLlm = await this.llm.extract(message.text, message.posted_at);
        // Only take the LLM's answer when it found more than the rules did; the rules
        // are cheaper and, on this channel style, usually at least as good.
        if (fromLlm.length > targets.length) {
          targets = fromLlm;
          source = 'llm';
        }
      } catch (error) {
        // Defence in depth: the shipped extractor catches its own errors, but the
        // worker must not depend on that. Enrichment failing is never a reason to
        // drop a message that the rules already parsed.
        logger.warn(
          { messageId: message.message_id, err: error instanceof Error ? error.message : String(error) },
          'llm enrichment failed, keeping rule results',
        );
      }
    }

    const now = Date.now();
    const rows: TargetParams[] = targets.map((t) => ({
      messageId: message.id,
      type: t.type,
      rawType: t.rawType,
      count: t.count,
      oblast: t.oblast,
      relation: t.relation,
      fromName: t.fromName,
      fromLat: t.fromLat,
      fromLon: t.fromLon,
      toName: t.toName,
      toLat: t.toLat,
      toLon: t.toLon,
      courseDeg: t.courseDeg,
      confidence: t.confidence,
      source,
      observedAt: t.observedAt ?? message.posted_at,
      createdAt: now,
    }));

    this.repo.saveTargets(
      message.id,
      rows,
      rows.length > 0 ? 'parsed' : 'unparsed',
      now,
      PARSER_VERSION,
    );

    return { targets, usedLlm };
  }
}
