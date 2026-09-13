import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { Gazetteer } from '../src/parser/gazetteer.js';
import { matchOblast } from '../src/parser/oblasts.js';
import { memoryDb, seedGazetteer } from './helpers.js';

const db = memoryDb();
seedGazetteer(db, [
  // The real shape of the ambiguity problem: one name, many places, different classes.
  { name: 'Михайлівка', oblast: 'sumska', place: 'hamlet', population: 300, lat: 50.9, lon: 34.2 },
  { name: 'Михайлівка', oblast: 'zaporizka', place: 'town', population: 8000, lat: 47.27, lon: 35.23 },
  { name: 'Михайлівка', oblast: 'donetska', place: 'village', population: 1500, lat: 48.1, lon: 37.2 },
  { name: 'Охтирка', oblast: 'sumska', place: 'town', population: 47000, lat: 50.31, lon: 34.89 },
  { name: 'Липова Долина', oblast: 'sumska', place: 'village', population: 3000, lat: 50.57, lon: 33.8 },
]);
const gaz = new Gazetteer(db);

describe('Gazetteer.resolve', () => {
  test('resolves an unambiguous inflected name with high confidence', () => {
    const hit = gaz.resolve('Охтирку');
    assert.equal(hit?.name, 'Охтирка');
    assert.equal(hit?.kind, 'settlement');
    assert.ok((hit?.confidence ?? 0) >= 0.95);
  });

  test('prefers the higher-ranked settlement when no oblast context is available', () => {
    // Town (8000) outranks village (1500) and hamlet (300).
    const hit = gaz.resolve('Михайлівку');
    assert.equal(hit?.oblast, 'zaporizka');
    assert.ok((hit?.confidence ?? 1) < 0.8, 'an unresolved collision must not look certain');
  });

  test('oblast context overrides rank', () => {
    // The Sumy hamlet is the lowest-ranked of the three, but the heading decides.
    const hit = gaz.resolve('Михайлівку', 'sumska');
    assert.equal(hit?.oblast, 'sumska');
    assert.ok((hit?.confidence ?? 0) >= 0.95, 'a unique match inside the oblast is certain');
  });

  test('prefers the longest matching phrase', () => {
    const hit = gaz.resolve('Липову Долину');
    assert.equal(hit?.name, 'Липова Долина');
  });

  test('falls back to an oblast as a coarse, low-confidence location', () => {
    const hit = gaz.resolve('Дніпропетровщину');
    assert.equal(hit?.kind, 'oblast');
    assert.equal(hit?.oblast, 'dnipropetrovska');
    assert.ok((hit?.confidence ?? 1) <= 0.5, 'an oblast centre is not a target position');
  });

  test('returns nothing rather than guessing', () => {
    assert.equal(gaz.resolve('Неіснуючесело'), undefined);
    assert.equal(gaz.resolve(''), undefined);
    assert.equal(gaz.resolve('   '), undefined);
  });

  test('ignores surrounding punctuation', () => {
    assert.equal(gaz.resolve('Охтирку,')?.name, 'Охтирка');
    assert.equal(gaz.resolve('(Охтирку)')?.name, 'Охтирка');
  });
});

describe('matchOblast', () => {
  test('recognises colloquial names in any case form', () => {
    for (const [token, key] of [
      ['Сумщина', 'sumska'], ['Сумщину', 'sumska'], ['Сумщині', 'sumska'],
      ['Харківщину', 'kharkivska'], ['Одещина', 'odeska'], ['Одещини', 'odeska'],
      ['Дніпропетровщину', 'dnipropetrovska'], ['Черкащина', 'cherkaska'],
      ['Донеччина', 'donetska'], ['Вінниччині', 'vinnytska'], ['Прикарпаття', 'ivano-frankivska'],
    ] as const) {
      assert.equal(matchOblast(token)?.key, key, token);
    }
  });

  test('does not match a settlement name', () => {
    assert.equal(matchOblast('Охтирка'), undefined);
  });
});
