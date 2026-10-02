export type { ParsedMessage } from '@horizont/parser';

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
