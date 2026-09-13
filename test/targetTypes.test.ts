import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { classifyType, extractCount } from '../src/parser/targetTypes.js';

describe('classifyType', () => {
  test('classifies the real vocabulary of these channels', () => {
    const cases: [string, string][] = [
      ['БпЛА курсом на Охтирку', 'uav'],
      ['2 шахеда на Зміїний', 'uav'],
      ['Реактивний БпЛА курсом на Краснопілля', 'jet_uav'],
      ['реактивний на Боромлю', 'jet_uav'],
      ['КАБи на Дніпропетровщину', 'kab'],
      ['💣 КАБ на Сумщину', 'kab'],
      ['Балістика на Київщину', 'ballistic'],
      ['крилата ракета курсом на Львів', 'cruise'],
      ['тактична авіація', 'aviation'],
      ['розвідувальний БпЛА', 'recon'],
    ];
    for (const [text, expected] of cases) {
      assert.equal(classifyType(text), expected, text);
    }
  });

  // "Реактивний БпЛА" must not fall through to plain uav — a jet UAV is several
  // times faster, which changes every distance and ETA estimate downstream.
  test('prefers the more specific class', () => {
    assert.equal(classifyType('Реактивний БпЛА'), 'jet_uav');
    assert.equal(classifyType('розвідувальний БпЛА'), 'recon');
  });

  test('falls back to the established context type', () => {
    assert.equal(classifyType('1 на Корець', 'uav'), 'uav');
    assert.equal(classifyType('1 на Корець'), 'unknown');
  });

  // Regression: ASCII \b never matches before Cyrillic, so the original KAB pattern
  // silently matched nothing at all.
  test('matches Cyrillic tokens despite word-boundary pitfalls', () => {
    assert.equal(classifyType('КАБи на Сумщину'), 'kab');
    assert.equal(classifyType('Сумщина: КАБ'), 'kab');
  });
});

describe('extractCount', () => {
  test('reads leading counts', () => {
    assert.equal(extractCount('3 БпЛА курсом на Сосницю'), 3);
    assert.equal(extractCount('2х БпЛА курсом на Липову Долину'), 2);
    assert.equal(extractCount('1 на Корець'), 1);
    assert.equal(extractCount('БпЛА курсом на Ніжин'), 1);
  });

  test('ignores numbers that are not counts', () => {
    assert.equal(extractCount('БпЛА курсом на Х-101'), 1);
    assert.equal(extractCount('Станом на 18.00'), 1);
  });
});
