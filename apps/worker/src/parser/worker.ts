import type { Repo, PendingMessage, TargetParams } from '../db/repo.js';
import { logger } from '../logger.js';
import type { MapPublisher } from '../map/publish.js';
import {
  DISABLED_EXTRACTOR,
  parseMessage,
  type Gazetteer,
  type LlmExtractor,
  type ParsedTarget,
} from '@horizont/parser';

/**
 * Bump to re-parse the entire archive after a parser change:
 *   UPDATE messages SET parse_state='pending' WHERE parser_version < <new>;
 */
export const PARSER_VERSION = 9;

export interface WorkerOptions {
  batchSize: number;
  intervalMs: number;
  /** Cap on LLM calls per batch, so a bad day cannot run up an unbounded bill. */
  llmBudgetPerBatch: number;
  /** Joins saved targets into map tracks. Absent in tests that do not need the map. */
  publisher?: MapPublisher;
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

  constructor(gazetteer: Gazetteer, repo: Repo, llm: LlmExtractor, opts: WorkerOptions) {
    this.repo = repo;
    this.gazetteer = gazetteer;
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
      const skipped = await this.repo.skipUnparseable(Date.now(), PARSER_VERSION);
      const batch = await this.repo.pendingMessages(this.opts.batchSize);

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
    const result = parseMessage(message.text, this.gazetteer, message.posted_at);
    let targets = result.targets;
    let source = 'rules';
    let usedLlm = false;

    if (result.needsLlm) {
      const answer = await this.consultLlm(message, llmAllowed);
      usedLlm = answer.called;
      // Only take the model's answer when it found more than the rules did; the rules
      // are cheaper and, on this channel style, usually at least as good.
      if (answer.targets && answer.targets.length > targets.length) {
        targets = answer.targets;
        source = 'llm';
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
      toArea: t.toArea === true,
      courseDeg: t.courseDeg,
      confidence: t.confidence,
      source,
      observedAt: t.observedAt ?? message.posted_at,
      createdAt: now,
    }));

    const previousTracks = (await this.opts.publisher?.beforeSave(message.id)) ?? [];
    await this.repo.saveTargets(
      message.id,
      rows,
      rows.length > 0 ? 'parsed' : 'unparsed',
      now,
      PARSER_VERSION,
    );
    await this.opts.publisher?.afterSave(message.id, previousTracks);

    return { targets, usedLlm };
  }

  /**
   * At most one model call per message, and one per distinct text ever.
   *
   * A cached answer is free and always used. Otherwise a call is made only when the
   * batch budget allows and this message has not already had its call — edits of a
   * message (@KozakChornobay edits nearly every post) never buy a second one.
   */
  private async consultLlm(
    message: PendingMessage,
    budgetLeft: boolean,
  ): Promise<{ targets: ParsedTarget[] | null; called: boolean }> {
    const cached = await this.repo.llmCached(message.content_hash);
    if (cached !== undefined) return { targets: revive(cached, message.posted_at), called: false };

    if (this.llm === DISABLED_EXTRACTOR || !budgetLeft || message.llm_called_at !== null) {
      return { targets: null, called: false };
    }

    let answer: ParsedTarget[] | null = null;
    try {
      answer = await this.llm.extract(message.text, message.posted_at);
    } catch (error) {
      // Defence in depth: the shipped extractors catch their own errors, but the
      // worker must not depend on that. Enrichment failing is never a reason to
      // drop a message that the rules already parsed.
      logger.warn(
        { messageId: message.message_id, err: error instanceof Error ? error.message : String(error) },
        'llm enrichment failed, keeping rule results',
      );
    }

    if (answer !== null) {
      await this.repo.recordLlmCall(
        message.id,
        message.content_hash,
        this.llm.name ?? 'llm',
        freeze(answer, message.posted_at),
        Date.now(),
      );
    }
    return { targets: answer, called: true };
  }
}

/** Cached targets keep observedAt as an offset from the post, so any repost can reuse them. */
function freeze(targets: ParsedTarget[], postedAt: number): string {
  return JSON.stringify(
    targets.map(({ observedAt, ...rest }) => ({
      ...rest,
      observedOffsetMs: observedAt === undefined ? null : observedAt - postedAt,
    })),
  );
}

function revive(json: string, postedAt: number): ParsedTarget[] {
  const rows = JSON.parse(json) as (Omit<ParsedTarget, 'observedAt'> & { observedOffsetMs: number | null })[];
  return rows.map(({ observedOffsetMs, ...rest }) => ({
    ...rest,
    ...(observedOffsetMs === null ? {} : { observedAt: postedAt + observedOffsetMs }),
  }));
}
