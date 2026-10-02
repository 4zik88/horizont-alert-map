import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Db } from '../db/index.js';
import { logger } from '../logger.js';

/**
 * Nightly database backup.
 *
 * Railway volumes have **no automatic backups**. Everything a user gave the bot —
 * chat id, coordinates, radius — exists in exactly one file, and the failure mode is
 * silent: a fresh volume starts an empty database and the service comes up healthy,
 * looking fine to everyone until someone notices their alerts stopped.
 *
 * `VACUUM INTO` is the right mechanism rather than copying the file: it takes a read
 * transaction, so it is consistent against concurrent writes and against the WAL,
 * and it writes a compacted database rather than a file plus its `-wal` sidecar.
 *
 * Scope, stated honestly: this protects against corruption, a bad migration and an
 * accidental delete. It does **not** protect against losing the volume, because the
 * copy lives on the same volume. Off-site would mean sending user coordinates to a
 * third party, which the spec forbids — so getting a copy off the box stays a manual
 * step (`npm run backup:fetch`).
 */
export interface BackupOptions {
  /** Directory for backup files. Created if missing. */
  dir: string;
  /** How many daily backups to keep. */
  keep: number;
}

const PREFIX = 'horizont-';
const SUFFIX = '.db';

/** `horizont-2026-09-14.db` — one per day, so a same-day re-run overwrites. */
export function backupName(now: number): string {
  return `${PREFIX}${new Date(now).toISOString().slice(0, 10)}${SUFFIX}`;
}

export function runBackup(db: Db, opts: BackupOptions, now = Date.now()): string {
  const dir = resolve(opts.dir);
  mkdirSync(dir, { recursive: true });

  const target = join(dir, backupName(now));
  /*
   * VACUUM INTO fails if the destination exists, and a same-day re-run (a restart,
   * say) must not be an error — the newer copy is simply the better one.
   */
  try {
    unlinkSync(target);
  } catch {
    // Not there: the normal case.
  }

  db.prepare('VACUUM INTO ?').run(target);
  const bytes = statSync(target).size;

  const pruned = prune(dir, opts.keep);
  logger.info({ file: backupName(now), bytes, pruned }, 'backup written');
  return target;
}

/** Delete all but the newest `keep` backups. Returns how many were removed. */
export function prune(dir: string, keep: number): number {
  const files = readdirSync(dir)
    .filter((f) => f.startsWith(PREFIX) && f.endsWith(SUFFIX))
    // The name is an ISO date, so lexical order is chronological order.
    .sort()
    .reverse();

  let removed = 0;
  for (const file of files.slice(Math.max(keep, 1))) {
    unlinkSync(join(dir, file));
    removed++;
  }
  return removed;
}
