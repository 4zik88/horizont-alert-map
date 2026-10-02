import type { ClientMessage, ServerMessage } from '@horizont/contract';

export type ConnState = 'connecting' | 'live' | 'reconnecting' | 'offline';

/** Exponential backoff with jitter: 1 s, 2 s, 4 s ... capped at 30 s. */
export function backoffMs(attempt: number, rand: number = Math.random()): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.75 + rand * 0.5));
}

export interface ConnectionOptions {
  url: string;
  /** The seq to resume from, read at every (re)connect. */
  lastSeq: () => number | null;
  onMessage: (msg: ServerMessage) => void;
  onState: (s: ConnState) => void;
}

const PING_EVERY_MS = 25_000;
const PONG_TIMEOUT_MS = 10_000;

/**
 * The /ws client: resumes from the last seq on every open, pings, and reconnects with
 * backoff. It knows nothing about the state; `main` folds frames through the reducer.
 */
export class Connection {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  private readonly o: ConnectionOptions;

  constructor(o: ConnectionOptions) {
    this.o = o;
    addEventListener('online', () => this.reconnectNow());
    addEventListener('offline', () => this.o.onState('offline'));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && (!this.ws || this.ws.readyState > 1)) this.reconnectNow();
    });
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.ws?.close();
    this.ws = null;
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Ask the server for whatever we missed after a gap. */
  resume(): void {
    this.send({ t: 'resume', seq: this.o.lastSeq() });
  }

  private reconnectNow(): void {
    if (this.stopped) return;
    this.attempt = 0;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (!this.ws || this.ws.readyState > 1) this.open();
  }

  private open(): void {
    if (this.stopped) return;
    if (!navigator.onLine) {
      this.o.onState('offline');
      return;
    }
    this.o.onState(this.attempt === 0 ? 'connecting' : 'reconnecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.o.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.o.onState('live');
      this.resume();
      this.pingTimer = setInterval(() => {
        this.send({ t: 'ping' });
        this.pongTimer ??= setTimeout(() => ws.close(), PONG_TIMEOUT_MS);
      }, PING_EVERY_MS);
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      if (this.pongTimer) {
        clearTimeout(this.pongTimer);
        this.pongTimer = null;
      }
      this.o.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      this.scheduleRetry();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    this.o.onState(navigator.onLine ? 'reconnecting' : 'offline');
    const delay = backoffMs(this.attempt++);
    this.retryTimer = setTimeout(() => this.open(), delay);
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.pingTimer = this.pongTimer = this.retryTimer = null;
  }
}

export function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}
