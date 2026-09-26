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

  /*
   * The weapon, never the platform that launched it. "Пуски керованих авіаційних
   * бомб ворожою тактичною авіацією" is a guided-bomb attack; reading it as
   * "aviation" because the sentence mentions aircraft mislabels the threat and puts
   * the wrong speed behind every distance estimate.
   */
  test('classifies by the munition, not the aircraft carrying it', () => {
    assert.equal(
      classifyType('Пуски керованих авіаційних бомб ворожою тактичною авіацією на Одещину.'),
      'kab',
    );
    assert.equal(classifyType('авіаційні бомби на Запоріжжя'), 'kab');
    assert.equal(classifyType('Launches of UMPB-5 munitions'), 'kab');
    // The aircraft itself, with no munition named, is still aviation.
    assert.equal(classifyType('Тактична авіація в повітрі'), 'aviation');
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

/*
 * Named drone models, and the word that looks like one but is not.
 *
 * An unknown type is assumed to fly at 200 km/h, and the "could this reach you" gate
 * is distance divided by that — so a missing name is not a cosmetic problem, it is a
 * guessed speed and a guessed reach.
 */
describe('named drone models', () => {
  test('гербера, ланцет and молнія are Shahed-class drones', () => {
    assert.equal(classifyType('гербера в районі Звягеля курс на Рівненщину'), 'uav');
    assert.equal(classifyType('ланцет над Харковом'), 'uav');
    assert.equal(classifyType('молнія на Суми'), 'uav');
  });

  /*
   * The trap. "дорозвідка" is the most common untyped word in the corpus (21
   * messages) and reads like a reconnaissance drone, but it means "further intel on
   * X" — and X is named in the same line. Typing the word itself would relabel a
   * 700 km/h guided bomb as a 150 km/h scout, losing the reader time they do not have.
   */
  test('дорозвідка types the thing it reports on, not itself', () => {
    assert.equal(classifyType('дорозвідка по КАБах в бік Одеси Фонтанки'), 'kab');
    assert.equal(classifyType('дорозвідка по шахеду на Санжейку'), 'uav');
  });

  /*
   * Real message 1829: a Lancet line sat three blocks below "Реактивний шахед" and
   * inherited jet_uav from it — 600 km/h for something that flies at about 110.
   * A named model must override the inherited context.
   */
  test('a named model beats the type inherited from earlier lines', () => {
    assert.equal(classifyType('ланцет над Харковом', 'jet_uav'), 'uav');
    assert.equal(classifyType('гербера на Вишневе', 'jet_uav'), 'uav');
  });

  test('and does not disturb the reactive class it sits among', () => {
    assert.equal(classifyType('Реактивний шахед на Тростянець'), 'jet_uav');
    assert.equal(classifyType('2 реактивні шахеда на Магдалинівку'), 'jet_uav');
  });
});
