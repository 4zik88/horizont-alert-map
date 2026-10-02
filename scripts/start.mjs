/**
 * One start command for every Railway service: `HORIZONT_APP` picks the app.
 *
 * Railway reads one railway.json per repository root, and the CLI cannot point a
 * service at a different config file, so the choice lives in a service variable
 * instead. Unset means the worker, which is what this service was before the split.
 */
const app = process.env.HORIZONT_APP ?? 'worker';
if (app !== 'worker' && app !== 'api') {
  console.error(`HORIZONT_APP must be "worker" or "api", got "${app}"`);
  process.exit(1);
}
await import(new URL(`../apps/${app}/dist/index.js`, import.meta.url).href);
