import { connect, migrate, type Sql } from '@horizont/db';
import { logger } from '../logger.js';

/**
 * The worker's handle on Postgres. Every query goes through the `Sql` interface from
 * `@horizont/db`, so tests run the same statements against an in-process PGlite.
 */
export type Db = Sql;

/** Connect and bring the schema up to date. The URL is never logged. */
export async function openDb(url: string): Promise<Db> {
  const db = connect(url, {
    onError: (err) => logger.warn({ err: err.message }, 'postgres connection dropped; the pool replaces it'),
  });

  const version = await migrate(db, (m) =>
    logger.info({ version: m.version, name: m.name }, 'migration applied'),
  );
  logger.debug({ schemaVersion: version }, 'database ready');

  return db;
}

export async function closeDb(db: Db): Promise<void> {
  await db.close();
}
