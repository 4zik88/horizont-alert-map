import { config, redactedConfig } from './config.js';
import { closeDb, openDb } from './db/index.js';
import { Repo } from './db/repo.js';
import { seedGazetteerIfEmpty } from './db/seed.js';
import { startServer } from './http/server.js';
import { MapApi } from './http/api.js';
import { logger } from './logger.js';
import { createExtractor } from './parser/llm.js';
import { Gazetteer } from './parser/gazetteer.js';
import { ParseWorker } from './parser/worker.js';
import { Poller } from './telegram/poller.js';
import { TelegramApi } from './bot/api.js';
import { Bot } from './bot/bot.js';
import { AppState, Users } from './db/users.js';
import { Notifier, DEFAULT_NOTIFIER } from './notify/notifier.js';
import { AlertWatcher } from './alerts/watcher.js';
import { allowedChatIds, allowedUsernames } from './bot/access.js';
import { Maintenance } from './maintenance/index.js';

const SHUTDOWN_GRACE_MS = 5_000;

async function main(): Promise<void> {
  logger.info(
    { node: process.version, config: redactedConfig() },
    'horizont-alert starting',
  );

  const db = openDb(config.DB_PATH);
  // A fresh volume has no gazetteer, and without one the parser resolves nothing
  // while the service still reports healthy.
  seedGazetteerIfEmpty(db);
  const repo = new Repo(db);

  // The map is served only when a token is configured; without one the service is
  // still a healthy web service, it just has nothing public to show.
  const mapApi = config.MAP_TOKEN
    ? new MapApi(db, {
        targetWindowMs: config.MAP_TARGET_WINDOW_MS,
        feedLimit: config.MAP_FEED_LIMIT,
      })
    : undefined;
  if (!config.MAP_TOKEN) {
    logger.info('MAP_TOKEN not set — the map is disabled (run `npm run map:token`)');
  }

  const server = startServer(repo, mapApi, {
    port: config.PORT,
    pollIntervalMs: config.POLL_INTERVAL_MS,
    publicDir: config.PUBLIC_DIR,
  });

  const poller = new Poller(repo, {
    channels: config.CHANNELS,
    pollIntervalMs: config.POLL_INTERVAL_MS,
    jitterPct: config.POLL_JITTER_PCT,
    fetchTimeoutMs: config.FETCH_TIMEOUT_MS,
    maxBackoffMs: config.MAX_BACKOFF_MS,
    gapFillMaxPages: config.GAP_FILL_MAX_PAGES,
  });
  poller.start();

  const parser = new ParseWorker(db, repo, await createExtractor(new Gazetteer(db)), {
    batchSize: config.PARSE_BATCH_SIZE,
    intervalMs: config.PARSE_INTERVAL_MS,
    llmBudgetPerBatch: config.LLM_BUDGET_PER_BATCH,
  });
  parser.start();

  // The bot, notifier and alert watcher are optional: without a token the service
  // still ingests and parses, so it deploys cleanly before any secret is configured.
  const stoppables: { stop(): Promise<void> }[] = [];
  let telegramApi: TelegramApi | undefined;

  if (config.TELEGRAM_BOT_TOKEN) {
    const recipients = allowedChatIds().length + allowedUsernames().length;
    if (recipients === 0) {
      logger.warn(
        'TELEGRAM_BOT_TOKEN is set but ALLOWED_CHAT_IDS/ALLOWED_USERNAMES are empty — ' +
          'the bot will ignore everyone. Add yourself to the allowlist.',
      );
    }

    const api = new TelegramApi(config.TELEGRAM_BOT_TOKEN);
    telegramApi = api;
    const users = new Users(db);
    const state = new AppState(db);
    const gazetteer = new Gazetteer(db);

    const bot = new Bot(api, users, state, gazetteer, {
      pollTimeoutSeconds: config.BOT_POLL_TIMEOUT_SECONDS,
    });
    bot.start();
    stoppables.push(bot);

    const notifier = new Notifier(db, users, state, api, {
      ...DEFAULT_NOTIFIER,
      intervalMs: config.NOTIFY_INTERVAL_MS,
      cooldownMs: config.NOTIFY_COOLDOWN_MS,
      proximity: {
        minConfidence: config.NOTIFY_MIN_CONFIDENCE,
        maxAgeMs: config.NOTIFY_MAX_AGE_MS,
        courseToleranceDeg: config.NOTIFY_COURSE_TOLERANCE_DEG,
        leadMinutes: config.NOTIFY_LEAD_MINUTES,
      },
    });
    notifier.start();
    stoppables.push(notifier);


  } else {
    logger.info('TELEGRAM_BOT_TOKEN not set — bot and notifications disabled');
  }

  /*
   * Alerts are polled regardless of the bot.
   *
   * This used to sit inside the bot block, so with no bot token nothing was fetched
   * and the map reported "0 alerts" while raids were in progress. The map needs this
   * state as much as the bot does; sending DMs is the only part that needs Telegram.
   */
  const alertProvider =
    config.ALERTS_PROVIDER !== 'auto'
      ? config.ALERTS_PROVIDER
      : config.ALERTS_IN_UA_TOKEN ? 'alerts_in_ua' : 'alerts_in_ua_public';

  const watcher = new AlertWatcher(db, new Users(db), telegramApi, {
    provider: alertProvider,
    token: config.ALERTS_IN_UA_TOKEN,
    intervalMs: config.ALERTS_POLL_INTERVAL_MS,
    timeoutMs: 15_000,
  });
  watcher.start();
  stoppables.push(watcher);

  /*
   * Backups and retention live in the same process because the volume attaches to
   * exactly one service, and SQLite is single-writer.
   */
  const maintenance = new Maintenance(db, {
    backup: { dir: config.BACKUP_DIR, keep: config.BACKUP_KEEP },
    retentionMs: config.RETENTION_DAYS * 86_400_000,
    intervalMs: config.MAINTENANCE_INTERVAL_MS,
  });
  maintenance.start();
  stoppables.push(maintenance);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    // Backstop: if a fetch or a socket refuses to settle, exit anyway rather than
    // hanging until Railway SIGKILLs us.
    const hardExit = setTimeout(() => {
      logger.error('shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    hardExit.unref();

    await poller.stop();
    await parser.stop();
    for (const stoppable of stoppables) await stoppable.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb(db);

    logger.info('shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // A poller that silently stops polling is the worst failure mode, so crash loudly
  // and let Railway's restart policy bring us back.
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'unhandled rejection');
    process.exit(1);
  });
  process.on('uncaughtException', (error) => {
    logger.error({ err: error }, 'uncaught exception');
    process.exit(1);
  });
}

void main();
