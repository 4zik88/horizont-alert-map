import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

process.env['ALLOWED_CHAT_IDS'] = '111,222';
process.env['ALLOWED_USERNAMES'] = '@someone, Another';
const { isAllowed, isAllowedIn } = await import('../src/bot/access.js');

describe('isAllowed', () => {
  test('accepts listed chat ids', () => {
    assert.equal(isAllowed({ chatId: 111 }), true);
    assert.equal(isAllowed({ chatId: 222 }), true);
  });

  test('accepts listed usernames regardless of @ or case', () => {
    assert.equal(isAllowed({ chatId: 999, username: 'someone' }), true);
    assert.equal(isAllowed({ chatId: 999, username: '@SomeOne' }), true);
    assert.equal(isAllowed({ chatId: 999, username: 'another' }), true);
  });

  test('rejects everyone else', () => {
    assert.equal(isAllowed({ chatId: 999 }), false);
    assert.equal(isAllowed({ chatId: 999, username: 'stranger' }), false);
    assert.equal(isAllowed({ chatId: 999, username: '' }), false);
  });
});

describe('isAllowedIn — the policy itself', () => {
  // The case that matters most: a config slip must not silently open a private
  // family tool to the whole internet.
  test('an empty allowlist admits nobody, not everybody', () => {
    assert.equal(isAllowedIn({ chatId: 111, username: 'someone' }, [], []), false);
    assert.equal(isAllowedIn({ chatId: 0 }, [], []), false);
  });

  test('matches by id or by username', () => {
    assert.equal(isAllowedIn({ chatId: 5 }, [5], []), true);
    assert.equal(isAllowedIn({ chatId: 9, username: 'bob' }, [], ['bob']), true);
    assert.equal(isAllowedIn({ chatId: 9, username: 'eve' }, [5], ['bob']), false);
  });

  test('an absent or blank username never matches', () => {
    assert.equal(isAllowedIn({ chatId: 9 }, [], ['bob']), false);
    assert.equal(isAllowedIn({ chatId: 9, username: '' }, [], ['bob']), false);
  });
});
