import type { Db } from './index.js';
import type { ChannelState } from '../types.js';

/**
 * Every SQL string the worker's hot path runs lives here, so "what does the DB
 * actually contain" is a single file to read.
 *
 * A `Repo` wraps whichever `Sql` it was given: the pool, or a transaction handle. That
 * is how atomic work is expressed — `repo.transaction((tx) => ...)` hands the callback
 * a `Repo` bound to the transaction, and everything done through it commits together.
 * Inside that callback use only the handle you were given: the outer one is a
 * different connection (and on PGlite, a deadlock).
 */
export class Repo {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async ensureChannel(channel: string): Promise<void> {
    await this.db.query(
      `INSERT INTO channel_state (channel) VALUES ($1) ON CONFLICT DO NOTHING`,
      [channel],
    );
  }

  async getChannel(channel: string): Promise<ChannelState | undefined> {
    const { rows } = await this.db.query<ChannelStateRow>(
      `SELECT * FROM channel_state WHERE channel = $1`,
      [channel],
    );
    return rows[0] ? toChannelState(rows[0]) : undefined;
  }

  async listChannels(): Promise<ChannelState[]> {
    // COLLATE "C": byte order, as SQLite sorted it, whatever the server's locale.
    const { rows } = await this.db.query<ChannelStateRow>(
      `SELECT * FROM channel_state ORDER BY channel COLLATE "C"`,
    );
    return rows.map(toChannelState);
  }

  /** Returns true when a new row was inserted (as opposed to an existing id). */
  async tryInsertMessage(p: MessageParams): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `INSERT INTO messages
         (channel, message_id, posted_at, fetched_at, text, text_html,
          content_hash, has_media, is_sensitive)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT DO NOTHING`,
      [p.channel, p.messageId, p.postedAt, p.fetchedAt, p.text, p.textHtml,
        p.contentHash, p.hasMedia, p.isSensitive],
    );
    return rowCount === 1;
  }

  /**
   * Returns true when an existing row's text differed and was rewritten.
   *
   * Only fires when the text actually changed. Resetting parse_state is the seam that
   * makes step 2 re-parse edited posts for free — @KozakChornobay edits every message
   * as a target moves, so this is the normal path, not an edge case.
   */
  async tryUpdateMessage(p: MessageParams): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE messages
          SET text = $3,
              text_html = $4,
              content_hash = $5,
              has_media = $6,
              is_sensitive = $7,
              edited_at = $8,
              parse_state = 'pending',
              parsed_at = NULL
        WHERE channel = $1
          AND message_id = $2
          AND content_hash <> $5`,
      [p.channel, p.messageId, p.text, p.textHtml, p.contentHash, p.hasMedia,
        p.isSensitive, p.fetchedAt],
    );
    return rowCount === 1;
  }

  async markSuccess(channel: string, minId: number, maxId: number, now: number): Promise<void> {
    await this.db.query(
      `UPDATE channel_state
          SET last_message_id = GREATEST(last_message_id, $3),
              oldest_message_id = CASE
                WHEN oldest_message_id = 0 THEN $2
                ELSE LEAST(oldest_message_id, $2)
              END,
              last_success_at = $4,
              last_error = NULL,
              last_error_at = NULL,
              consecutive_failures = 0
        WHERE channel = $1`,
      [channel, minId, maxId, now],
    );
  }

  async markFailure(channel: string, error: string, now: number): Promise<void> {
    // Truncated: error strings go in the DB and the logs, never an HTML body.
    await this.db.query(
      `UPDATE channel_state
          SET last_error = $2,
              last_error_at = $3,
              consecutive_failures = consecutive_failures + 1
        WHERE channel = $1`,
      [channel, error.slice(0, 300), now],
    );
  }

  /**
   * Messages waiting to be parsed, oldest first.
   *
   * Oldest-first so a backlog is worked in the order the messages arrived. Sensitive
   * messages are excluded here and closed out by skipUnparseable: impact and
   * air-defence summaries must never become map targets.
   */
  async pendingMessages(limit: number): Promise<PendingMessage[]> {
    // `id` breaks ties the way SQLite's rowid scan did.
    const { rows } = await this.db.query<PendingMessage>(
      `SELECT id, channel, message_id, text, posted_at, content_hash, llm_called_at
         FROM messages
        WHERE parse_state = 'pending' AND is_sensitive = 0 AND text <> ''
        ORDER BY posted_at, id
        LIMIT $1`,
      [limit],
    );
    return rows;
  }

  /** A cached model answer for this text, if one exists. */
  async llmCached(contentHash: string): Promise<string | undefined> {
    const { rows } = await this.db.query<{ targets: string }>(
      'SELECT targets FROM llm_cache WHERE content_hash = $1',
      [contentHash],
    );
    return rows[0]?.targets;
  }

  /** Store a model answer and spend the message's one call, atomically. */
  async recordLlmCall(
    messageId: number,
    contentHash: string,
    provider: string,
    targets: string,
    now: number,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO llm_cache (content_hash, provider, targets, created_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (content_hash) DO UPDATE SET targets = excluded.targets, created_at = excluded.created_at`,
        [contentHash, provider, targets, now],
      );
      await tx.query('UPDATE messages SET llm_called_at = $1 WHERE id = $2', [now, messageId]);
    });
  }

  /** Close out messages that must never be parsed (sensitive, or media-only). */
  async skipUnparseable(now: number, version: number): Promise<number> {
    const { rowCount } = await this.db.query(
      `UPDATE messages SET parse_state = 'skipped', parsed_at = $1, parser_version = $2
        WHERE parse_state = 'pending' AND (is_sensitive = 1 OR text = '')`,
      [now, version],
    );
    return rowCount;
  }

  /**
   * Replace a message's targets and record the outcome, atomically.
   *
   * Re-parsing an edited message replaces its targets rather than duplicating them.
   * Returns the new target ids in `seq` order.
   */
  async saveTargets(
    messageId: number,
    targets: TargetParams[],
    state: 'parsed' | 'unparsed' | 'error',
    now: number,
    version: number,
  ): Promise<number[]> {
    return this.db.transaction(async (tx) => {
      await tx.query('DELETE FROM targets WHERE message_id = $1', [messageId]);

      // One statement per target, in order, so the ids come back in seq order by
      // construction rather than by relying on RETURNING order. A message carries a
      // handful of targets at most.
      const ids: number[] = [];
      for (const [seq, t] of targets.entries()) {
        const { rows } = await tx.query<{ id: number }>(
          `INSERT INTO targets
             (message_id, seq, type, raw_type, count, oblast, relation,
              from_name, from_lat, from_lon, to_name, to_lat, to_lon,
              course_deg, confidence, source, observed_at, created_at, to_area)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
           RETURNING id`,
          [t.messageId, seq, t.type, t.rawType, t.count, t.oblast, t.relation,
            t.fromName, t.fromLat, t.fromLon, t.toName, t.toLat, t.toLon,
            t.courseDeg, t.confidence, t.source, t.observedAt, t.createdAt, t.toArea ? 1 : 0],
        );
        ids.push(rows[0]!.id);
      }

      await tx.query(
        `UPDATE messages SET parse_state = $2, parsed_at = $3, parser_version = $4 WHERE id = $1`,
        [messageId, state, now, version],
      );
      return ids;
    });
  }

  /** Run `fn` in one transaction, with a `Repo` bound to it. */
  transaction<T>(fn: (repo: Repo) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => fn(new Repo(tx)));
  }
}

export interface PendingMessage {
  id: number;
  channel: string;
  message_id: number;
  text: string;
  posted_at: number;
  content_hash: string;
  /** Set once the message has used its one model call. */
  llm_called_at: number | null;
}

export interface TargetParams {
  messageId: number;
  type: string;
  rawType: string | null;
  count: number;
  oblast: string | null;
  relation: string;
  fromName: string | null;
  fromLat: number | null;
  fromLon: number | null;
  toName: string | null;
  toLat: number | null;
  toLon: number | null;
  /** The destination is a whole region; see ParsedTarget.toArea. */
  toArea?: boolean;
  courseDeg: number | null;
  confidence: number;
  source: string;
  observedAt: number;
  createdAt: number;
}

/** Raw `channel_state` row shape, exactly as the database returns it. */
interface ChannelStateRow {
  channel: string;
  last_message_id: number;
  oldest_message_id: number;
  last_success_at: number | null;
  last_error: string | null;
  last_error_at: number | null;
  consecutive_failures: number;
  enabled: number;
}

export interface MessageParams {
  channel: string;
  messageId: number;
  postedAt: number;
  fetchedAt: number;
  text: string;
  textHtml: string | null;
  contentHash: string;
  hasMedia: number;
  isSensitive: number;
}

function toChannelState(row: ChannelStateRow): ChannelState {
  return {
    channel: row.channel,
    lastMessageId: row.last_message_id,
    oldestMessageId: row.oldest_message_id,
    lastSuccessAt: row.last_success_at,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at,
    consecutiveFailures: row.consecutive_failures,
    enabled: row.enabled,
  };
}
