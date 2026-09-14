/**
 * One-off backup:
 *   npm run backup
 *
 * The service does this nightly on its own; this is for taking a copy before a
 * migration or a risky change.
 *
 * To get a copy off the Railway volume — which is what protects against losing the
 * volume itself, and which no automatic job here can do without shipping user
 * coordinates to a third party:
 *
 *   railway run npm run backup
 *   railway ssh "cat /data/backups/horizont-$(date +%F).db" > ./horizont-backup.db
 */
import { closeDb, openDb } from '../src/db/index.js';
import { config } from '../src/config.js';
import { runBackup } from '../src/maintenance/backup.js';

const db = openDb(config.DB_PATH);
try {
  const file = runBackup(db, { dir: config.BACKUP_DIR, keep: config.BACKUP_KEEP });
  console.log(file);
} finally {
  closeDb(db);
}
