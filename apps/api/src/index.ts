import { connect, migrate } from '@horizont/db';
import { loadConfig } from './config.js';
import { buildServer, startBackground } from './server.js';

const config = loadConfig();
const sql = connect(config.DATABASE_URL, { max: 10 });
await migrate(sql);

const { app, hub } = await buildServer({ sql, config });
await hub.start();
const stopBackground = startBackground(sql, config.SOURCE_STALE_MS);

await app.listen({ host: config.HOST, port: config.PORT });

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, 'shutting down');
    stopBackground();
    await hub.stop().catch(() => {});
    await app.close().catch(() => {});
    await sql.close().catch(() => {});
    process.exit(0);
  });
}
