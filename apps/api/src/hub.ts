import type { ServerMessage, Snapshot } from '@horizont/contract';
import { EVENTS_CHANNEL, eventsAfter, latestSeq, oldestSeq, type Sql, type StoredEvent } from '@horizont/db';

/** What the hub needs from a socket. A `ws` WebSocket satisfies it. */
export interface Peer {
  send(data: string): void;
  readonly readyState: number;
}

const OPEN = 1;

interface Client {
  peer: Peer;
  /** Highest seq this client has been sent; null until it has resumed. */
  sent: number | null;
}

/**
 * Fans the event log out to open sockets.
 *
 * Postgres NOTIFY says "something new"; the hub then reads the log by seq. Reading
 * rather than trusting the notification payload means a dropped LISTEN connection
 * loses nothing — the backstop poll picks up where the last read stopped — and every
 * client gets events strictly in order with no gaps.
 */
export class Hub {
  private readonly clients = new Set<Client>();
  private readonly sql: Sql;
  private readonly snapshot: () => Promise<Snapshot>;
  private head = 0;
  private reading: Promise<void> | null = null;
  private again = false;
  private unlisten: (() => Promise<void>) | null = null;
  private timer: NodeJS.Timeout | undefined;

  constructor(sql: Sql, snapshot: () => Promise<Snapshot>) {
    this.sql = sql;
    this.snapshot = snapshot;
  }

  async start(backstopMs = 5_000): Promise<void> {
    this.head = await latestSeq(this.sql);
    this.unlisten = await this.sql.listen(EVENTS_CHANNEL, () => void this.pull());
    this.timer = setInterval(() => void this.pull(), backstopMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.unlisten?.();
  }

  get size(): number {
    return this.clients.size;
  }

  add(peer: Peer): Client {
    const client: Client = { peer, sent: null };
    this.clients.add(client);
    return client;
  }

  remove(client: Client): void {
    this.clients.delete(client);
  }

  /**
   * Bring a client up to date. A known, still-held seq gets the missing events; no seq
   * or one already pruned gets a full snapshot.
   */
  async resume(client: Client, seq: number | null): Promise<void> {
    const oldest = await oldestSeq(this.sql);
    const canReplay = seq !== null && seq <= this.head && (oldest === null || seq >= oldest - 1);

    if (!canReplay) {
      const snap = await this.snapshot();
      this.send(client, { t: 'snapshot', ...snap });
      client.sent = snap.seq;
    } else {
      client.sent = seq;
    }
    // Anything after the snapshot or the requested seq, including events that landed
    // while the snapshot was being built.
    for (const e of await eventsAfter(this.sql, client.sent ?? 0)) this.deliver(client, e);
  }

  /** Read new events and push them to every resumed client. Serialised. */
  async pull(): Promise<void> {
    if (this.reading) {
      this.again = true;
      return this.reading;
    }
    this.reading = (async () => {
      do {
        this.again = false;
        const events = await eventsAfter(this.sql, this.head);
        for (const e of events) {
          this.head = e.seq;
          for (const client of this.clients) this.deliver(client, e);
        }
      } while (this.again);
    })().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }

  private deliver(client: Client, e: StoredEvent): void {
    if (client.sent === null || e.seq <= client.sent) return;
    this.send(client, { t: 'event', seq: e.seq, at: e.at, e: e.e });
    client.sent = e.seq;
  }

  private send(client: Client, msg: ServerMessage): void {
    if (client.peer.readyState !== OPEN) return;
    client.peer.send(JSON.stringify(msg));
  }
}
