import pg from 'pg';

/**
 * The one database interface the apps program against.
 *
 * Two implementations: `pg` against a real server (production, the dev cluster) and
 * PGlite — Postgres compiled to WASM, in-process — for tests, so the suite needs no
 * server and every test file gets a clean database in milliseconds. Both are the same
 * Postgres, so a query that passes in tests means the same thing in production.
 *
 * Conventions every caller relies on:
 *  - `$1, $2 …` placeholders only.
 *  - `bigint` columns come back as JS numbers. All times are epoch ms, far below 2^53.
 */
export interface QueryResult<T> {
  rows: T[];
  /** Rows inserted, updated or deleted by the statement. */
  rowCount: number;
}

export interface Sql {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Several statements, no parameters. For migrations and test setup. */
  exec(text: string): Promise<void>;
  /** Run `fn` in one transaction. Nested calls join the outer transaction. */
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  /** Subscribe to NOTIFY on a channel. Resolves to an unsubscribe function. */
  listen(channel: string, onPayload: (payload: string) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

const INT8 = 20;

// ─── pg ────────────────────────────────────────────────────────────────────────

/** A pooled connection to a real server. */
export function connect(
  connectionString: string,
  opts: { max?: number; onError?: (err: Error) => void } = {},
): Sql {
  const onError = opts.onError ?? ((err: Error) => console.error('postgres connection error:', err.message));
  const types = {
    getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
      oid === INT8
        ? (value: string) => Number(value)
        : pg.types.getTypeParser(oid, format as 'text')) as typeof pg.types.getTypeParser,
  };
  const pool = new pg.Pool({ connectionString, max: opts.max ?? 5, types });
  /*
   * An idle pooled connection that the server drops (restart, failover, idle timeout)
   * emits 'error' on the pool. Unhandled, that is an uncaught exception and the whole
   * process exits. The pool discards the dead client itself; reporting it is enough.
   */
  pool.on('error', onError);

  const fromClient = (client: pg.PoolClient): Sql => ({
    async query<T>(text: string, params?: unknown[]) {
      const r = await client.query(text, params as unknown[]);
      return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
    },
    async exec(text) {
      await client.query(text);
    },
    transaction: (fn) => fn(fromClient(client)),
    listen: () => Promise.reject(new Error('listen() is not available inside a transaction')),
    close: () => Promise.resolve(),
  });

  return {
    async query<T>(text: string, params?: unknown[]) {
      const r = await pool.query(text, params as unknown[]);
      return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
    },
    async exec(text) {
      await pool.query(text);
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(fromClient(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async listen(channel, onPayload) {
      // LISTEN needs a connection of its own for as long as the subscription lives.
      const client = new pg.Client({ connectionString, types });
      client.on('error', onError);
      await client.connect();
      client.on('notification', (n) => {
        if (n.channel === channel) onPayload(n.payload ?? '');
      });
      await client.query(`LISTEN ${pg.escapeIdentifier(channel)}`);
      return async () => {
        await client.end().catch(() => {});
      };
    },
    close: () => pool.end(),
  };
}

// ─── PGlite ────────────────────────────────────────────────────────────────────

interface PGliteLike {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[]; affectedRows?: number }>;
  exec(text: string): Promise<unknown>;
  transaction<T>(fn: (tx: PGliteTx) => Promise<T>): Promise<T>;
  listen(channel: string, cb: (payload: string) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}
interface PGliteTx {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[]; affectedRows?: number }>;
  exec(text: string): Promise<unknown>;
}

/** Wrap an in-process PGlite instance. Created with int8 parsed to numbers. */
export function fromPGlite(db: PGliteLike): Sql {
  const fromTx = (tx: PGliteTx): Sql => ({
    async query<T>(text: string, params?: unknown[]) {
      const r = await tx.query<T>(text, params);
      return { rows: r.rows, rowCount: r.affectedRows ?? 0 };
    },
    async exec(text) {
      await tx.exec(text);
    },
    transaction: (fn) => fn(fromTx(tx)),
    listen: () => Promise.reject(new Error('listen() is not available inside a transaction')),
    close: () => Promise.resolve(),
  });

  return {
    async query<T>(text: string, params?: unknown[]) {
      const r = await db.query<T>(text, params);
      return { rows: r.rows, rowCount: r.affectedRows ?? 0 };
    },
    async exec(text) {
      await db.exec(text);
    },
    transaction: (fn) => db.transaction((tx) => fn(fromTx(tx))),
    listen: (channel, cb) => db.listen(channel, cb),
    close: () => db.close(),
  };
}

export const PGLITE_PARSERS = { [INT8]: (value: string) => Number(value) };
