/*
 * Loaded before every test file (`--import` in the test script).
 *
 * `src/config.ts` requires DATABASE_URL and exits without it. Tests never connect to
 * it — each file gets an in-process PGlite from `@horizont/db/testing` — so a
 * placeholder is enough to let config load.
 */
process.env['DATABASE_URL'] ??= 'postgres://unused@127.0.0.1:1/tests-use-pglite';
