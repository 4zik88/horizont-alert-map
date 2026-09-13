import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { parseIotString } from '../src/alerts/client.js';
import { OBLASTS } from '../src/parser/oblasts.js';

// 27 positions in the API's fixed order.
const NONE = 'N'.repeat(27);
const at = (index: number, flag: string) => NONE.slice(0, index) + flag + NONE.slice(index + 1);

describe('parseIotString', () => {
  test('maps every position to an oblast we know', () => {
    const state = parseIotString(NONE);
    assert.equal(state.active.size, 27);
    for (const key of state.active.keys()) {
      if (key === 'sevastopol') continue; // not a separate oblast in our lexicon
      assert.ok(OBLASTS.some((o) => o.key === key), `${key} should exist in OBLASTS`);
    }
  });

  // A wrong index would send the Kharkiv all-clear to someone in Lviv.
  test('reads the documented position for each oblast', () => {
    assert.equal(parseIotString(at(0, 'A')).active.get('vinnytska'), true);
    assert.equal(parseIotString(at(16, 'A')).active.get('sumska'), true);
    assert.equal(parseIotString(at(18, 'A')).active.get('kharkivska'), true);
    assert.equal(parseIotString(at(24, 'A')).active.get('kyiv'), true);
  });

  test('treats a partial alert as active', () => {
    // A partial alert still means take cover.
    assert.equal(parseIotString(at(16, 'P')).active.get('sumska'), true);
    assert.equal(parseIotString(at(16, 'N')).active.get('sumska'), false);
  });

  test('only the named oblast is active', () => {
    const state = parseIotString(at(16, 'A'));
    assert.equal(state.active.get('sumska'), true);
    assert.equal(state.active.get('kharkivska'), false);
    assert.equal([...state.active.values()].filter(Boolean).length, 1);
  });

  // A shortened or changed response must not be interpreted as "all clear
  // everywhere", which would fire a false all-clear to every user at once.
  test('refuses to interpret a truncated response', () => {
    assert.equal(parseIotString('NNNA').active.size, 0);
    assert.equal(parseIotString('').active.size, 0);
  });
});
