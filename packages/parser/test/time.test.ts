import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Gazetteer } from '../src/gazetteer.js';
import { parseMessage } from '../src/message.js';
import { kyivOffsetMs, resolveObservedAt, statedTime } from '../src/time.js';

const HOUR = 3_600_000;

describe('Kyiv time', () => {
  test('offset is +3 h in summer and +2 h in winter', () => {
    assert.equal(kyivOffsetMs(Date.UTC(2026, 6, 1, 12)), 3 * HOUR);
    assert.equal(kyivOffsetMs(Date.UTC(2026, 0, 15, 12)), 2 * HOUR);
  });

  test('a winter time resolves with the winter offset', () => {
    const posted = Date.UTC(2026, 0, 15, 12, 10); // 14:10 Kyiv
    assert.equal(resolveObservedAt('14:00', posted), Date.UTC(2026, 0, 15, 12, 0));
  });
});

describe('statedTime', () => {
  test('takes observation times', () => {
    assert.equal(statedTime('О 15:20 пуски шахедів:'), '15:20');
    assert.equal(statedTime('⚠️ [13.09.2026 16:25] Пуск Shahed-136/Герань-2 з району Донецьк'), '16:25');
    assert.equal(statedTime('реактивний над Охтиркою об 11.05'), '11.05');
  });

  test('ignores forecast arrival times', () => {
    assert.equal(statedTime('пуски шахедів з Гвардійського\nякщо в бік Одещини +- 21:40'), undefined);
    assert.equal(statedTime('буде орієнтовно о 23:50'), undefined);
    assert.equal(statedTime('прибуде приблизно о 02:10'), undefined);
  });

  test('ignores numbers that are not clock times', () => {
    assert.equal(statedTime('Х-101 на Київ'), undefined);
    assert.equal(statedTime('Станом на 18.00 атакував 323 БпЛА'), undefined);
  });
});

describe('parseMessage stamps a stated observation time', () => {
  const gaz = Gazetteer.fromSeed([
    { name: 'Охтирка', oblast: 'sumska', place: 'town', population: 47000, lat: 50.31, lon: 34.89 },
  ]);
  const posted = Date.UTC(2026, 8, 13, 8, 20); // 11:20 Kyiv

  test('"об 11.05" becomes 08:05 UTC', () => {
    const { targets } = parseMessage('Реактивний БпЛА курсом на Охтирку об 11.05', gaz, posted);
    assert.equal(targets.length, 1);
    assert.equal(targets[0]!.observedAt, Date.UTC(2026, 8, 13, 8, 5));
  });

  test('no stated time leaves the post time to the caller', () => {
    const { targets } = parseMessage('Реактивний БпЛА курсом на Охтирку', gaz, posted);
    assert.equal(targets[0]!.observedAt, undefined);
  });
});
