import { PGlite } from '@electric-sql/pglite';
import { migrate } from './migrations.js';
import { fromPGlite, PGLITE_PARSERS, type Sql } from './sql.js';

/** A fresh, migrated, in-process Postgres. No server needed. Close it after the test. */
export async function testDb(): Promise<Sql> {
  const sql = fromPGlite(new PGlite({ parsers: PGLITE_PARSERS }) as never);
  await migrate(sql);
  return sql;
}

/** Empty every table and restart sequences, so one database can serve a whole file. */
export async function truncateAll(sql: Sql): Promise<void> {
  const { rows } = await sql.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
  );
  if (rows.length === 0) return;
  await sql.exec(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
}
