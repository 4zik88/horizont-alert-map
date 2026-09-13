/** A message as extracted from a t.me/s/ preview page. Pure data, no DB concerns. */
export interface ParsedMessage {
  channel: string;
  messageId: number;
  /** Epoch ms UTC, from the <time datetime> attribute. Authoritative event time. */
  postedAt: number;
  /** Normalised plain text: <br/> -> \n, entities decoded. '' for media-only posts. */
  text: string;
  /** Raw innerHTML of the message body, or null when the post has no text block. */
  textHtml: string | null;
  hasMedia: boolean;
}

export interface ChannelState {
  channel: string;
  lastMessageId: number;
  oldestMessageId: number;
  lastSuccessAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  consecutiveFailures: number;
  enabled: number;
}

export interface IngestResult {
  inserted: number;
  updated: number;
  minId: number | null;
  maxId: number | null;
}

/** Why a poll cycle failed. Drives retry-vs-give-up and the log level. */
export type FetchFailureKind = 'http' | 'redirect' | 'timeout' | 'network' | 'empty';

export class FetchError extends Error {
  readonly kind: FetchFailureKind;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(
    kind: FetchFailureKind,
    message: string,
    status?: number,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'FetchError';
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }

  /** A redirect means the channel is gone or private — retrying will never help. */
  get permanent(): boolean {
    return this.kind === 'redirect';
  }
}
