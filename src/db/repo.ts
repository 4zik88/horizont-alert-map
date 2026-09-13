import type { Db } from './index.js';
import type { ChannelState } from '../types.js';

/**
 * Every SQL string in the project lives here, so "what does the DB actually contain"
 * is a single file to read. Statements are prepared once per process.
 */
export class Repo {
  private readonly insertMessage;
  private readonly updateMessageText;
  private readonly selectChannel;
  private readonly insertChannel;
  private readonly updateSuccess;
  private readonly updateFailure;
  private readonly selectAllChannels;
  private readonly selectPending;
  private readonly insertTarget;
  private readonly deleteTargets;
  private readonly markParsed;
  private readonly markSensitiveSkipped;
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
    this.insertMessage = db.prepare(`
      INSERT OR IGNORE INTO messages
        (channel, message_id, posted_at, fetched_at, text, text_html,
         content_hash, has_media, is_sensitive)
      VALUES
        (@channel, @messageId, @postedAt, @fetchedAt, @text, @textHtml,
         @contentHash, @hasMedia, @isSensitive)
    `);

    // Only fires when the text actually changed. Resetting parse_state is the seam
    // that makes step 2 re-parse edited posts for free — @KozakChornobay edits every
    // message as a target moves, so this is the normal path, not an edge case.
    this.updateMessageText = db.prepare(`
      UPDATE messages
         SET text = @text,
             text_html = @textHtml,
             content_hash = @contentHash,
             has_media = @hasMedia,
             is_sensitive = @isSensitive,
             edited_at = @fetchedAt,
             parse_state = 'pending',
             parsed_at = NULL
       WHERE channel = @channel
         AND message_id = @messageId
         AND content_hash <> @contentHash
    `);

    this.selectChannel = db.prepare(`SELECT * FROM channel_state WHERE channel = ?`);
    this.selectAllChannels = db.prepare(`SELECT * FROM channel_state ORDER BY channel`);

    this.insertChannel = db.prepare(`
      INSERT OR IGNORE INTO channel_state (channel) VALUES (?)
    `);

    this.updateSuccess = db.prepare(`
      UPDATE channel_state
         SET last_message_id = MAX(last_message_id, @maxId),
             oldest_message_id = CASE
               WHEN oldest_message_id = 0 THEN @minId
               ELSE MIN(oldest_message_id, @minId)
             END,
             last_success_at = @now,
             last_error = NULL,
             last_error_at = NULL,
             consecutive_failures = 0
       WHERE channel = @channel
    `);

    // Oldest-first so a backlog is worked in the order the messages arrived.
    // Sensitive messages are excluded here and closed out by markSensitiveSkipped:
    // impact and air-defence summaries must never become map targets.
    this.selectPending = db.prepare(`
      SELECT id, channel, message_id, text, posted_at
        FROM messages
       WHERE parse_state = 'pending' AND is_sensitive = 0 AND text <> ''
       ORDER BY posted_at
       LIMIT ?
    `);

    this.markSensitiveSkipped = db.prepare(`
      UPDATE messages SET parse_state = 'skipped', parsed_at = @now, parser_version = @version
       WHERE parse_state = 'pending' AND (is_sensitive = 1 OR text = '')
    `);

    this.insertTarget = db.prepare(`
      INSERT INTO targets
        (message_id, seq, type, raw_type, count, oblast, relation,
         from_name, from_lat, from_lon, to_name, to_lat, to_lon,
         course_deg, confidence, source, observed_at, created_at)
      VALUES
        (@messageId, @seq, @type, @rawType, @count, @oblast, @relation,
         @fromName, @fromLat, @fromLon, @toName, @toLat, @toLon,
         @courseDeg, @confidence, @source, @observedAt, @createdAt)
    `);

    // Re-parsing an edited message replaces its targets rather than duplicating them.
    this.deleteTargets = db.prepare(`DELETE FROM targets WHERE message_id = ?`);

    this.markParsed = db.prepare(`
      UPDATE messages SET parse_state = @state, parsed_at = @now, parser_version = @version
       WHERE id = @id
    `);

    this.updateFailure = db.prepare(`
      UPDATE channel_state
         SET last_error = @error,
             last_error_at = @now,
             consecutive_failures = consecutive_failures + 1
       WHERE channel = @channel
    `);
  }

  ensureChannel(channel: string): void {
    this.insertChannel.run(channel);
  }

  getChannel(channel: string): ChannelState | undefined {
    const row = this.selectChannel.get(channel) as ChannelStateRow | undefined;
    return row ? toChannelState(row) : undefined;
  }

  listChannels(): ChannelState[] {
    return (this.selectAllChannels.all() as ChannelStateRow[]).map(toChannelState);
  }

  /** Returns true when a new row was inserted (as opposed to an existing id). */
  tryInsertMessage(params: MessageParams): boolean {
    return this.insertMessage.run(params).changes === 1;
  }

  /** Returns true when an existing row's text differed and was rewritten. */
  tryUpdateMessage(params: MessageParams): boolean {
    return this.updateMessageText.run(params).changes === 1;
  }

  markSuccess(channel: string, minId: number, maxId: number, now: number): void {
    this.updateSuccess.run({ channel, minId, maxId, now });
  }

  markFailure(channel: string, error: string, now: number): void {
    // Truncated: error strings go in the DB and the logs, never an HTML body.
    this.updateFailure.run({ channel, error: error.slice(0, 300), now });
  }

  /** Messages waiting to be parsed, oldest first. */
  pendingMessages(limit: number): PendingMessage[] {
    return this.selectPending.all(limit) as PendingMessage[];
  }

  /** Close out messages that must never be parsed (sensitive, or media-only). */
  skipUnparseable(now: number, version: number): number {
    return this.markSensitiveSkipped.run({ now, version }).changes;
  }

  /** Replace a message's targets and record the outcome, atomically. */
  saveTargets(
    messageId: number,
    targets: TargetParams[],
    state: 'parsed' | 'unparsed' | 'error',
    now: number,
    version: number,
  ): void {
    this.db.transaction(() => {
      this.deleteTargets.run(messageId);
      targets.forEach((target, seq) => this.insertTarget.run({ ...target, seq }));
      this.markParsed.run({ id: messageId, state, now, version });
    })();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}

export interface PendingMessage {
  id: number;
  channel: string;
  message_id: number;
  text: string;
  posted_at: number;
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
  courseDeg: number | null;
  confidence: number;
  source: string;
  observedAt: number;
  createdAt: number;
}

/** Raw `channel_state` row shape, exactly as SQLite returns it. */
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
