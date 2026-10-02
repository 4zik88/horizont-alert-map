import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Gazetteer } from '../src/gazetteer.js';
import { parseMessage } from '../src/message.js';

const gaz = Gazetteer.fromSeed([
  { name: 'Чернігів', oblast: 'chernihivska', place: 'city', population: 280000, lat: 51.4982, lon: 31.2893 },
  { name: 'Ніжин', oblast: 'chernihivska', place: 'city', population: 70000, lat: 51.05, lon: 31.88 },
]);

test('a report that names only an oblast is marked as an area (kpszsu/82475)', () => {
  const { targets } = parseMessage(
    '🏍 Реактивні БпЛА на півночі Чернігівщини вздовж кордону з Білоруссю, курс на південь',
    gaz,
  );
  assert.equal(targets.length, 1);
  assert.equal(targets[0]!.toName, 'Чернігівська');
  assert.equal(targets[0]!.toArea, true);
});

test('a report naming a settlement is a point', () => {
  const { targets } = parseMessage('Чернігівщина:\nРеактивний БпЛА курсом на Ніжин', gaz);
  assert.equal(targets[0]!.toName, 'Ніжин');
  assert.equal(targets[0]!.toArea, false);
});
