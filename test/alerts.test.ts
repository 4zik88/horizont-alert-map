import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isActive, normaliseArea, parseComUa, parseIotString, parseSitrep,
} from '../src/alerts/client.js';
import { OBLASTS } from '../src/parser/oblasts.js';

// 27 positions in the API's fixed order.
const NONE = 'N'.repeat(27);
const at = (index: number, flag: string) => NONE.slice(0, index) + flag + NONE.slice(index + 1);

describe('parseIotString', () => {
  test('maps every position to an oblast we know', () => {
    const state = parseIotString(NONE);
    assert.equal(state.levels.size, 27);
    for (const key of state.levels.keys()) {
      if (key === 'sevastopol') continue; // not a separate oblast in our lexicon
      assert.ok(OBLASTS.some((o) => o.key === key), `${key} should exist in OBLASTS`);
    }
  });

  // A wrong index would send the Kharkiv all-clear to someone in Lviv.
  test('reads the documented position for each oblast', () => {
    assert.equal(parseIotString(at(0, 'A')).levels.get('vinnytska'), 'full');
    assert.equal(parseIotString(at(16, 'A')).levels.get('sumska'), 'full');
    assert.equal(parseIotString(at(18, 'A')).levels.get('kharkivska'), 'full');
    assert.equal(parseIotString(at(24, 'A')).levels.get('kyiv'), 'full');
  });

  // 'P' is the yellow (drone-threat) level, 'A' the red (missile) one. Both are
  // active, but the map must be able to tell them apart.
  test('distinguishes the yellow level from the red one', () => {
    assert.equal(parseIotString(at(16, 'P')).levels.get('sumska'), 'partial');
    assert.equal(parseIotString(at(16, 'A')).levels.get('sumska'), 'full');
    assert.equal(parseIotString(at(16, 'N')).levels.get('sumska'), 'none');
    assert.equal(isActive('partial'), true);
    assert.equal(isActive('full'), true);
    assert.equal(isActive('none'), false);
  });

  test('only the named oblast is active', () => {
    const state = parseIotString(at(16, 'A'));
    assert.equal(state.levels.get('sumska'), 'full');
    assert.equal(state.levels.get('kharkivska'), 'none');
    assert.equal([...state.levels.values()].filter((l) => l !== 'none').length, 1);
  });

  // A shortened or changed response must not be interpreted as "all clear
  // everywhere", which would fire a false all-clear to every user at once.
  test('refuses to interpret a truncated response', () => {
    assert.equal(parseIotString('NNNA').levels.size, 0);
    assert.equal(parseIotString('').levels.size, 0);
  });
});

describe('parseComUa', () => {
  const states = (over: Record<string, boolean> = {}) =>
    ['Вінницька', 'Волинська', 'Дніпропетровська', 'Донецька', 'Житомирська', 'Закарпатська',
     'Запорізька', 'Івано-Франківська', 'Київська', 'Кіровоградська', 'Луганська', 'Львівська',
     'Миколаївська', 'Одеська', 'Полтавська', 'Рівненська', 'Сумська', 'Тернопільська',
     'Харківська', 'Херсонська', 'Хмельницька', 'Черкаська', 'Чернівецька', 'Чернігівська']
      .map((n) => ({ name: `${n} область`, alert: over[n] === true }))
      .concat([{ name: 'м. Київ', alert: over['Київ'] === true }]);

  test('maps every oblast name onto a known key', () => {
    const state = parseComUa(states());
    assert.equal(state.levels.size, 25);
    assert.equal(state.levels.get('sumska'), 'none');
    assert.equal(state.levels.get('kyiv'), 'none');
  });

  test('reports an active oblast as the red level', () => {
    const state = parseComUa(states({ 'Сумська': true }));
    assert.equal(state.levels.get('sumska'), 'full');
    assert.equal(state.levels.get('kharkivska'), 'none');
  });

  // A short or renamed response must not be read as "all clear everywhere", which
  // would fire a false all-clear to every user at once.
  test('refuses a suspiciously short response', () => {
    assert.equal(parseComUa([{ name: 'Сумська область', alert: true }]).levels.size, 0);
    assert.equal(parseComUa([]).levels.size, 0);
  });
});

describe('parseSitrep — the public alerts.in.ua report', () => {
  const md = readFileSync(join(import.meta.dirname, 'fixtures', 'sitrep.md'), 'utf8');

  test('reads the oblasts actually under an air-raid alert', () => {
    const state = parseSitrep(md);
    const active = [...state.levels].filter(([, v]) => isActive(v)).map(([k]) => k).sort();
    assert.deepEqual(active, [
      'chernihivska', 'dnipropetrovska', 'donetska', 'kharkivska',
      'khersonska', 'mykolaivska', 'sumska', 'zaporizka',
    ]);
  });

  /*
   * Red is oblast-wide coverage, not threat type. Donetsk names all 8 of its raions
   * and Zaporizhzhia all 5, so both are red; Sumy names 1 raion of 5 and Chernihiv 2
   * of 5, so they are the yellow level. Reading "air raid alert" as red painted every
   * one of these solid red while the reference map showed most of them yellow.
   */
  test('separates the red level from the yellow one by raion coverage', () => {
    const state = parseSitrep(md);
    const red = [...state.levels].filter(([, v]) => v === 'full').map(([k]) => k).sort();
    assert.deepEqual(red, ['donetska', 'zaporizka']);

    assert.equal(state.levels.get('sumska'), 'partial');
    assert.equal(state.levels.get('chernihivska'), 'partial');
    // 4 raions of 7 named, the rest hromadas and the city.
    assert.equal(state.levels.get('kharkivska'), 'partial');
  });

  /*
   * A shelling threat with no declared air raid alert is not an air raid. The
   * reference map marks it with a point icon and leaves the oblast unfilled; we used
   * to tint the whole oblast yellow for it.
   */
  test('ignores a threat that is not a declared air-raid alert', () => {
    const threatOnly = md.replace(
      '**Sumska oblast (Сумська область)** — air raid alert in effect',
      '**Sumska oblast (Сумська область)** — artillery shelling threat in effect',
    );
    assert.equal(parseSitrep(threatOnly).levels.get('sumska'), 'none');
    assert.deepEqual(parseSitrep(threatOnly).areas.get('sumska'), undefined);
  });

  /*
   * The decisive case. Luhansk and Crimea carry a permanent administrative alert that
   * says nothing about a live threat. A keyless alternative (alerts.com.ua) was
   * measured reporting *only* those two while eight oblasts were genuinely under
   * alert — reading them as real would show a standing emergency forever and bury the
   * alerts that matter.
   */
  test('excludes standing nominal alerts over occupied territory', () => {
    const state = parseSitrep(md);
    assert.equal(state.levels.get('krym'), 'none');
    assert.equal(state.levels.get('luhanska'), 'none');
  });

  test('excludes launch-site activity on Russian territory', () => {
    // Voronezh appears in the report but is not a Ukrainian oblast under alert.
    const state = parseSitrep(md);
    assert.equal([...state.levels.keys()].some((k) => k.includes('voron')), false);
  });

  test('leaves quiet oblasts explicitly clear', () => {
    const state = parseSitrep(md);
    assert.equal(state.levels.get('lvivska'), 'none');
    assert.equal(state.levels.get('zakarpatska'), 'none');
    assert.equal(state.levels.size >= 25, true);
  });

  test('extracts what is being tracked right now', () => {
    const state = parseSitrep(md);
    assert.ok(state.threats.length >= 1);
    assert.match(state.threats[0]!.kind, /drone/i);
    assert.match(state.threats[0]!.time, /^\d{2}:\d{2}$/);
  });

  // A changed report shape must yield nothing rather than an empty alert map, which
  // would read as a nationwide all-clear and fire a false "відбій" to everyone.
  test('refuses a report it does not recognise', () => {
    assert.equal(parseSitrep('# Something else entirely').levels.size, 0);
    assert.equal(parseSitrep('').levels.size, 0);
  });
});

describe('parseSitrep — the areas actually under warning', () => {
  const md = readFileSync(join(import.meta.dirname, 'fixtures', 'sitrep.md'), 'utf8');

  /*
   * Alerts are declared per raion. Without this list the map can only shade whole
   * oblasts, which claims an emergency across an area the size of a small country
   * when a single raion is warned.
   */
  test('lists the affected areas per oblast', () => {
    const state = parseSitrep(md);
    const kharkiv = state.areas.get('kharkivska') ?? [];
    assert.ok(kharkiv.includes('ізюмський'), `expected Iziumskyi, got ${kharkiv.join(', ')}`);
    assert.ok(kharkiv.includes('богодухівський'));
    assert.ok(kharkiv.length >= 5);
  });

  test('strips the administrative suffixes that OSM adds', () => {
    assert.equal(normaliseArea('Ізюмський'), 'ізюмський');
    assert.equal(normaliseArea('Ізюмський район'), 'ізюмський');
    assert.equal(normaliseArea('м. Харків'), 'харків');
    assert.equal(normaliseArea('Куп’янський'), "куп'янський");
  });

  test('records nothing for an oblast with no alert', () => {
    const state = parseSitrep(md);
    assert.equal(state.areas.get('lvivska'), undefined);
  });
});
