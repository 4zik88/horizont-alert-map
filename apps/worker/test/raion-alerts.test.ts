import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { messageFor, raionStates } from '../src/alerts/watcher.js';
import { raionAt, raionName, raionsOf } from '@horizont/geo/node';

/*
 * Alerts are declared per raion and were being announced per oblast.
 *
 * "Повітряна тривога — Вінницька обл." reached a reader in Kozyatyn whenever anything
 * happened anywhere in an area the size of a small country — and the matching all-clear
 * could arrive while their own raion was still under warning. Both directions are
 * wrong, and the second is the dangerous one.
 */

describe('raionAt', () => {
  test('places a point in its own raion, not its nearest town', () => {
    // Kozyatyn is in Khmilnyk raion, though Kozyatyn town gives the raion its old name.
    assert.equal(raionAt(49.716, 28.8318)?.match, 'хмільницький');
    assert.equal(raionAt(49.243, 30.105)?.match, 'уманський');
    assert.equal(raionAt(49.9923, 36.231)?.oblast, 'kharkivska');
  });

  test('is undefined outside every polygon', () => {
    assert.equal(raionAt(44.0, 32.0), undefined, 'the Black Sea is in no raion');
    // Kyiv city is its own administrative unit and has no raion polygon; the reader
    // there falls back to the oblast-level message, which is the correct one for them.
    assert.equal(raionAt(50.4501, 30.5234), undefined);
  });

  test('covers every oblast that has raions', () => {
    const missing = raionsOf('kyivska');
    assert.equal(missing.length, 7);
    assert.match(raionName('хмільницький'), /Хмільницький/);
  });
});

describe('raionStates', () => {
  const vinnytsia = raionsOf('vinnytska').map((r) => r.match);

  test('warns only the raions the feed named', () => {
    const states = raionStates('vinnytska', 'partial', ['хмільницький']);
    const active = states.filter((s) => s.active).map((s) => s.match);

    assert.deepEqual(active, ['хмільницький']);
    assert.equal(states.length, vinnytsia.length, 'every raion gets a state, warned or not');
  });

  test('an all-clear clears every raion of the oblast', () => {
    const states = raionStates('vinnytska', 'none', []);
    assert.ok(states.every((s) => !s.active));
  });

  /*
   * A warning naming only hromadas or a city resolves to no raion polygon at all. The
   * warning is still real, so the whole oblast is treated as warned — the error falls
   * toward telling someone rather than leaving them unwarned.
   */
  test('a warning that names no raion still warns the whole oblast', () => {
    const states = raionStates('dnipropetrovska', 'partial', ['нікопольська громада']);
    assert.ok(states.length > 0);
    assert.ok(states.every((s) => s.active));
  });

  test('an oblast with no raions of its own yields nothing', () => {
    assert.deepEqual(raionStates('kyiv', 'full', []), []);
  });
});

describe('messageFor', () => {
  const none = { starts: [], stops: [], oblastStarts: [], oblastStops: [] };

  test('names the reader’s own raion', () => {
    const text = messageFor(
      { oblast: 'vinnytska', raion: 'хмільницький' },
      { ...none, starts: ['хмільницький'] },
    );
    assert.equal(text, '🚨 Повітряна тривога — Хмільницький район');
  });

  test('says nothing when another raion of the same oblast is warned', () => {
    const text = messageFor(
      { oblast: 'vinnytska', raion: 'хмільницький' },
      { ...none, starts: ['гайсинський'], oblastStarts: ['vinnytska'] },
    );
    assert.equal(text, undefined, 'an alert 150 km away is not this reader’s alert');
  });

  /*
   * The dangerous direction. An oblast-wide all-clear used to reach everyone in the
   * oblast, including readers whose own raion was still under warning.
   */
  test('an all-clear elsewhere does not clear this reader', () => {
    const text = messageFor(
      { oblast: 'vinnytska', raion: 'хмільницький' },
      { ...none, stops: ['гайсинський'], oblastStops: ['vinnytska'] },
    );
    assert.equal(text, undefined);
  });

  test('clears the reader when their own raion clears', () => {
    const text = messageFor(
      { oblast: 'vinnytska', raion: 'хмільницький' },
      { ...none, stops: ['хмільницький'] },
    );
    assert.equal(text, '✅ Відбій тривоги — Хмільницький район');
  });

  test('falls back to the oblast for a reader in no raion', () => {
    const text = messageFor({ oblast: 'kyiv', raion: null }, { ...none, oblastStarts: ['kyiv'] });
    assert.equal(text, '🚨 Повітряна тривога — Київ обл.');
  });

  test('a reader with no location at all is told nothing', () => {
    assert.equal(messageFor({ oblast: null, raion: null }, { ...none, starts: ['x'] }), undefined);
  });
});
