import { config, redactedConfig } from './config.js';
import { closeDb, openDb } from './db/index.js';
import { Repo } from './db/repo.js';
import { startServer } from './http/server.js';
import { logger } from './logger.js';
import { createExtractor } from './parser/llm.js';
import { Gazetteer } from './parser/gazetteer.js';
import { ParseWorker } from './parser/worker.js';
import { Poller } from './telegram/poller.js';

const SHUTDOWN_GRACE_MS = 5_000;

async function main(): Promise<void> {
  logger.info(
    { node: process.version, config: redactedConfig() },
    'horizont-alert starting',
  );

  const db = openDb(config.DB_PATH);
  const repo = new Repo(db);

  const server = startServer(repo, {
    port: config.PORT,
    pollIntervalMs: config.POLL_INTERVAL_MS,
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
