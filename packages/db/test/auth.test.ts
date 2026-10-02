import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { consumeLogin, createSession, deleteSession, issueLogin, LOGIN_TTL_MS, revokeAccess, sessionUser, type Sql } from '../src/index.js';
import { testDb, truncateAll } from '../src/testing.js';

const sql: Sql = await testDb();
after(() => sql.close());
beforeEach(async () => {
  await truncateAll(sql);
  await sql.query(
    `INSERT INTO users (chat_id, username, oblast, is_active, created_at, updated_at) VALUES (42, 'me', 'sumska', 1, 0, 0), (7, 'gone', null, 0, 0, 0)`,
  );
});
const NOW = 1_790_000_000_000;

test('a link logs in once', async () => {
  const { token } = await issueLogin(sql, 42, NOW);
  assert.equal(await consumeLogin(sql, { token }, NOW + 1000), 42);
  assert.equal(await consumeLogin(sql, { token }, NOW + 2000), null, 'single use');
});

test('the code works however it is typed, and spends the same login', async () => {
  const { token, code } = await issueLogin(sql, 42, NOW);
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(await consumeLogin(sql, { code: ` ${code.toLowerCase().replace('-', ' ')} ` }, NOW), 42);
  assert.equal(await consumeLogin(sql, { token }, NOW), null, 'the link died with the code');
});

test('an expired login and a newer /start refuse; /stop does not lock anyone out', async () => {
  const old = await issueLogin(sql, 42, NOW);
  assert.equal(await consumeLogin(sql, { token: old.token }, NOW + LOGIN_TTL_MS + 1), null);

  const first = await issueLogin(sql, 42, NOW);
  await issueLogin(sql, 42, NOW + 1000);
  assert.equal(await consumeLogin(sql, { token: first.token }, NOW + 2000), null, 'superseded');

  // chat 7 sent /stop (is_active = 0): warnings off, map access unaffected.
  const stopped = await issueLogin(sql, 7, NOW);
  assert.equal(await consumeLogin(sql, { token: stopped.token }, NOW), 7);
});

test('a session resolves to its user until logout', async () => {
  const id = await createSession(sql, 42, NOW);
  assert.deepEqual(await sessionUser(sql, id, NOW + 1000), { chatId: 42, username: 'me', oblast: 'sumska' });
  assert.equal(await sessionUser(sql, 'forged', NOW), null);
  await deleteSession(sql, id);
  assert.equal(await sessionUser(sql, id, NOW), null);
});

test('revoking access ends sessions and pending logins', async () => {
  const id = await createSession(sql, 42, NOW);
  const { token } = await issueLogin(sql, 42, NOW);
  assert.equal(await revokeAccess(sql, [42]), 1);
  assert.equal(await sessionUser(sql, id, NOW), null);
  assert.equal(await consumeLogin(sql, { token }, NOW), null);
});

test('only hashes are stored', async () => {
  const { token } = await issueLogin(sql, 42, NOW);
  const id = await createSession(sql, 42, NOW);
  const dump = JSON.stringify((await sql.query('SELECT * FROM login_tokens')).rows) +
    JSON.stringify((await sql.query('SELECT * FROM sessions')).rows);
  assert.ok(!dump.includes(token) && !dump.includes(id));
});
