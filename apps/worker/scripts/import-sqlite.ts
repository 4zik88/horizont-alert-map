/**
 * One-off: copy the SQLite database the worker used to run on into Postgres.
 *
 *   DATABASE_URL=postgres://… pnpm import:sqlite ./data/app.db
 *   SQLITE_IMPORT_PATH=./data/app.db pnpm import:sqlite
 *   pnpm import:sqlite ./data/app.db --force     # replace rows already in Postgres
 *
 * Migrates the target first, then copies every worker table with its ids preserved,
 * and moves each id sequence past the highest imported id so new rows do not collide.
 * Everything happens in one transaction: a failure leaves the target as it was.
 *
 * Refuses to touch a target whose worker tables already hold rows, unless `--force`,
 * which TRUNCATEs them first — CASCADE, so rows in tables that reference them (map
 * sessions, login tokens and push subscriptions reference `users`) go too.
 *
 * Tolerates an older SQLite schema: a table missing from the source is skipped, and a
 * column missing from the source takes its Postgres default (a pre-raion `users` row
 * gets a null raion, which the worker backfills at boot). The source is opened
 * read-only. Never point this at the live file while the old service is writing it;
 * copy it first.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { connect, migrate, type Sql } from '@horizont/db';

/** Copy order respects foreign keys: messages before targets, toponyms before forms. */
const TABLES = [
  'users',
  'channel_state',
  'messages',
  'targets',
  'oblast_alerts',
  'raion_alerts',
  'app_state',
  'notice_ledger',
  'llm_cache',
  'toponyms',
  'toponym_forms',
] as const;

/** Rows per INSERT. Messages carry their raw HTML, so they go in smaller batches. */
const BATCH: Partial<Record<(typeof TABLES)[number], number>> = { messages: 1_000 };
const DEFAULT_BATCH = 5_000;

interface TableResult {
  table: string;
  source: number | null;
  target: number;
  missingColumns: string[];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const pathArg = args.find((a) => !a.startsWith('--')) ?? process.env['SQLITE_IMPORT_PATH'];
  const url = process.env['DATABASE_URL'];

  if (!pathArg) fail('No SQLite path. Pass it as an argument or set SQLITE_IMPORT_PATH.');
  if (!url) fail('DATABASE_URL is not set — it names the Postgres database to import into.');
  const path = resolve(pathArg);
  if (!existsSync(path)) fail(`No such file: ${path}`);

  const source = new Database(path, { readonly: true, fileMustExist: true });
  const target = connect(url, { max: 1 });

  try {
    console.log(`source: ${path} (SQLite schema version ${source.pragma('user_version', { simple: true })})`);

    const version = await migrate(target, (m) => console.log(`migration applied: ${m.version} ${m.name}`));
    console.log(`target: schema version ${version}`);

    const occupied = await nonEmptyTables(target);
    if (occupied.length > 0 && !force) {
      fail(
        `Refusing to import: the target already has rows in ${occupied.join(', ')}.\n` +
          'Re-run with --force to TRUNCATE them (and the tables that reference them) first.',
      );
    }

    const started = Date.now();
    const results = await target.transaction(async (tx) => {
      if (occupied.length > 0) {
        console.log(`--force: truncating ${TABLES.join(', ')} (CASCADE)`);
        await tx.exec(`TRUNCATE ${TABLES.map(quote).join(', ')} RESTART IDENTITY CASCADE`);
      }

      const out: TableResult[] = [];
      for (const table of TABLES) out.push(await copyTable(source, tx, table));
      await resetSequences(tx);
      return out;
    });

    console.log(`\nimported in ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
    console.log(`${'table'.padEnd(16)} ${'sqlite'.padStart(8)} ${'postgres'.padStart(9)}`);
    let mismatch = false;
    for (const r of results) {
      const src = r.source === null ? '(absent)' : String(r.source);
      const ok = r.source === null ? r.target === 0 : r.source === r.target;
      if (!ok) mismatch = true;
      const note = r.missingColumns.length > 0 ? `  defaults for: ${r.missingColumns.join(', ')}` : '';
      console.log(`${r.table.padEnd(16)} ${src.padStart(8)} ${String(r.target).padStart(9)}${ok ? '' : '  MISMATCH'}${note}`);
    }

    const skipped = sourceTables(source).filter(
      (t) => !(TABLES as readonly string[]).includes(t) && !t.startsWith('sqlite_'),
    );
    if (skipped.length > 0) console.log(`\nnot imported (not part of the Postgres schema): ${skipped.join(', ')}`);

    if (mismatch) fail('Row counts differ between source and target.');
  } finally {
    source.close();
    await target.close();
  }
}

async function nonEmptyTables(sql: Sql): Promise<string[]> {
  const out: string[] = [];
  for (const table of TABLES) {
    const { rows } = await sql.query(`SELECT 1 FROM ${quote(table)} LIMIT 1`);
    if (rows.length > 0) out.push(table);
  }
  return out;
}

async function copyTable(source: Database.Database, tx: Sql, table: string): Promise<TableResult> {
  const targetColumns = await columnsOf(tx, table);

  if (!sourceTables(source).includes(table)) {
    return { table, source: null, target: 0, missingColumns: [] };
  }

  const sourceColumns = new Set(
    (source.pragma(`table_info(${quote(table)})`) as { name: string }[]).map((c) => c.name),
  );
  const extra = [...sourceColumns].filter((c) => !targetColumns.some((t) => t.name === c));
  if (extra.length > 0) {
    // A column only SQLite has would be silently dropped. Say so rather than guess.
    throw new Error(`${table}: source has columns the Postgres schema does not: ${extra.join(', ')}`);
  }

  const columns = targetColumns.filter((c) => sourceColumns.has(c.name));
  const missingColumns = targetColumns.filter((c) => !sourceColumns.has(c.name)).map((c) => c.name);

  // Insertion order where there is one; WITHOUT ROWID tables scan in key order anyway.
  const order = hasRowid(source, table) ? ' ORDER BY rowid' : '';
  const select = source.prepare(
    `SELECT ${columns.map((c) => quote(c.name)).join(', ')} FROM ${quote(table)}${order}`,
  ).raw();
  const insert =
    `INSERT INTO ${quote(table)} (${columns.map((c) => quote(c.name)).join(', ')}) ` +
    `SELECT * FROM unnest(${columns.map((c, i) => `$${i + 1}::${c.type}[]`).join(', ')})`;

  const size = BATCH[table as keyof typeof BATCH] ?? DEFAULT_BATCH;
  let batch: unknown[][] = [];
  let copied = 0;

  const flush = async () => {
    if (batch.length === 0) return;
    const arrays = columns.map((_, i) => batch.map((row) => row[i]));
    copied += (await tx.query(insert, arrays)).rowCount;
    batch = [];
  };

  for (const row of select.iterate() as IterableIterator<unknown[]>) {
    batch.push(row);
    if (batch.length >= size) await flush();
  }
  await flush();

  const total = (source.prepare(`SELECT COUNT(*) AS n FROM ${quote(table)}`).get() as { n: number }).n;
  const { rows } = await tx.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${quote(table)}`);
  process.stdout.write(`  ${table}: ${copied} rows\n`);
  return { table, source: total, target: rows[0]!.n, missingColumns };
}

/** Column names and their exact Postgres types, in table order. */
async function columnsOf(sql: Sql, table: string): Promise<{ name: string; type: string }[]> {
  const { rows } = await sql.query<{ name: string; type: string }>(
    `SELECT a.attname AS name, format_type(a.atttypid, NULL) AS type
       FROM pg_attribute a
      WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [table],
  );
  return rows;
}

/** Move every imported table's id sequence past the highest imported id. */
async function resetSequences(tx: Sql): Promise<void> {
  for (const table of TABLES) {
    for (const { name } of await columnsOf(tx, table)) {
      const { rows } = await tx.query<{ seq: string | null }>(
        'SELECT pg_get_serial_sequence($1, $2) AS seq',
        [table, name],
      );
      const seq = rows[0]?.seq;
      if (!seq) continue;
      // is_called = false: the next nextval() returns exactly max + 1 (or 1 when empty).
      const { rows: [set] } = await tx.query<{ next: number }>(
        `SELECT setval($1, COALESCE(MAX(${quote(name)}), 0) + 1, false) AS next FROM ${quote(table)}`,
        [seq],
      );
      console.log(`  sequence ${seq} -> next ${set!.next}`);
    }
  }
}

function hasRowid(db: Database.Database, table: string): boolean {
  try {
    db.prepare(`SELECT rowid FROM ${quote(table)} LIMIT 0`);
    return true;
  } catch {
    return false;
  }
}

function sourceTables(db: Database.Database): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[])
    .map((r) => r.name);
}

/** Identifiers here come from a fixed list or the catalog, never from input. */
function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function fail(message: string): never {
  console.error(`\n!! ${message}`);
  process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
