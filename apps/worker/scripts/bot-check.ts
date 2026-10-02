/**
 * Verifies the bot setup without sending anything:
 *   npm run bot:check
 *
 * Confirms the token, shows who is on the allowlist, lists registered users, and
 * replays recent targets through the real proximity logic to show who *would* have
 * been warned. Nothing is sent and nothing is written.
 *
 * User coordinates are never printed — only oblast and radius — because this output
 * is the kind of thing that gets pasted into a chat.
 */
import { config, redactedConfig } from '../src/config.js';
import { allowedChatIds, allowedUsernames } from '../src/bot/access.js';
import { TelegramApi } from '../src/bot/api.js';
import { formatAlertBatch, type AlertLine } from '../src/bot/format.js';
import { Users } from '../src/db/users.js';
import { MIGRATIONS, connect, type Sql } from '@horizont/db';
import { raionName } from '@horizont/geo/node';
import { oblastByKey } from '@horizont/parser';
import type { TargetType } from '@horizont/parser';
import { DEFAULT_PROXIMITY, matchTarget, type TargetView } from '../src/notify/proximity.js';

async function main(): Promise<void> {
  const cfg = redactedConfig();
  console.log(`TELEGRAM_BOT_TOKEN = ${cfg['TELEGRAM_BOT_TOKEN']}`);
  console.log(`ALERTS_IN_UA_TOKEN = ${cfg['ALERTS_IN_UA_TOKEN']}`);

  const ids = allowedChatIds();
  const names = allowedUsernames();
  console.log(`allowlist: ${ids.length} chat id(s), ${names.length} username(s)`);
  if (ids.length === 0 && names.length === 0) {
    console.log('  !! empty — the bot will ignore everyone, including you.');
    console.log('     Set ALLOWED_CHAT_IDS or ALLOWED_USERNAMES in .env');
  }

  if (!config.TELEGRAM_BOT_TOKEN) {
    console.log('\nNo bot token set. Create one with @BotFather and put it in .env as');
    console.log('TELEGRAM_BOT_TOKEN=..., then run this again.');
    return;
  }

  try {
    const me = await new TelegramApi(config.TELEGRAM_BOT_TOKEN).getMe();
    console.log(`\ntoken OK — bot is @${me.username ?? me.id}`);
  } catch (error) {
    console.log(`\n!! token rejected: ${error instanceof Error ? error.message : error}`);
    return;
  }

  // Connected without migrating: this check writes nothing.
  const db = connect(config.DATABASE_URL);
  try {
    await report(db);
  } finally {
    await db.close();
  }
}

async function report(db: Sql): Promise<void> {
  /*
   * This does not migrate, so an out-of-date database would fail below with a bare
   * "column does not exist" instead of saying what was wrong. Check the version and
   * say it plainly.
   */
  const { rows: [tracked] } = await db.query<{ exists: boolean }>(
    `SELECT to_regclass('schema_migrations') IS NOT NULL AS exists`,
  );
  const version = tracked?.exists
    ? (await db.query<{ v: number }>('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations'))
      .rows[0]!.v
    : 0;
  const latest = MIGRATIONS.at(-1)!.version;
  if (version < latest) {
    console.log(`\n!! the database is at schema version ${version}, needs ${latest}.`);
    console.log('   Start the service once (pnpm dev) to migrate it, then run this again.');
    return;
  }

  const users = new Users(db);
  const registered = await users.notifiable();

  console.log(`\nregistered users with a location: ${registered.length}`);
  for (const user of registered) {
    // The raion is what alerts are keyed on, so it is what is worth showing. Still
    // never the coordinates — this output is the kind of thing that gets pasted into
    // a chat.
    const where = user.raion
      ? raionName(user.raion)
      : `${user.oblast ? (oblastByKey(user.oblast)?.name ?? user.oblast) : 'unknown'} обл. (no raion)`;
    const live = user.location_kind === 'live' ? ', live' : '';
    console.log(`  chat ${user.chat_id}: ${where}, radius ${user.radius_km} km${live}`);
  }
  if (registered.length === 0) {
    console.log('  (send /start and a location to the bot, then run this again)');
  }

  // Dry run: which recent targets would have reached whom.
  interface TargetRow {
    id: number; type: string; count: number;
    to_name: string | null; to_lat: number | null; to_lon: number | null;
    from_lat: number | null; from_lon: number | null;
    course_deg: number | null; confidence: number; observed_at: number;
  }

  const { rows } = await db.query<TargetRow>(`
    SELECT id, type, count, to_name, to_lat, to_lon, from_lat, from_lon,
           course_deg, confidence, observed_at
      FROM targets ORDER BY observed_at DESC, id LIMIT 400
  `);

  const targets = rows.map((r) => ({
    count: r.count,
    view: {
      id: r.id, type: r.type as TargetType, toName: r.to_name,
      toLat: r.to_lat, toLon: r.to_lon, fromLat: r.from_lat, fromLon: r.from_lon,
      courseDeg: r.course_deg, confidence: r.confidence, observedAt: r.observed_at,
    } satisfies TargetView,
  }));

  if (registered.length > 0 && targets.length > 0) {
    const newest = Math.max(...targets.map((t) => t.view.observedAt));
    // Anchor "now" to the newest target so an old corpus still demonstrates something.
    const proximity = { ...DEFAULT_PROXIMITY, now: newest };

    console.log(`\ndry run over the ${targets.length} most recent targets (nothing is sent):`);
    for (const user of registered) {
      if (user.lat === null || user.lon === null) continue;
      const lines: AlertLine[] = [];
      for (const { view, count } of targets) {
        const match = matchTarget(
          view,
          { chatId: user.chat_id, lat: user.lat, lon: user.lon, radiusKm: user.radius_km },
          proximity,
        );
        if (match) {
          lines.push({
            type: view.type, count, toName: view.toName,
            distanceKm: match.distanceKm, etaMin: match.etaMin, reason: match.reason,
          });
        }
      }
      console.log(`\n  chat ${user.chat_id}: ${lines.length} target(s) would have matched`);
      if (lines.length > 0) {
        lines.sort((a, b) => a.distanceKm - b.distanceKm);
        console.log(formatAlertBatch(lines.slice(0, 5)).split('\n').map((l) => `    ${l}`).join('\n'));
      }
    }
    console.log('\nMany matches here means the radius is wide or the corpus is busy —');
    console.log('tune with /radius, NOTIFY_MIN_CONFIDENCE and NOTIFY_LEAD_MINUTES.');
  }
}

void main();
