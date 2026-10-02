import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { loadGazetteer } from '../src/db/gazetteer.js';
import { parseMessage } from '@horizont/parser';
import { seedGazetteerIfEmpty } from '../src/db/seed.js';
import { memoryDb } from './helpers.js';

describe('gazetteer seed', () => {
  /*
   * A fresh Railway volume has empty tables and the service still reports healthy,
   * so an unseeded deploy fails silently: every message goes to the feed as text and
   * the map draws nothing. This is the test that says the deploy works at all.
   */
  test('an empty database can resolve place names after seeding', () => {
    const db = memoryDb();
    assert.equal((db.prepare('SELECT COUNT(*) n FROM toponyms').get() as { n: number }).n, 0);

    const seeded = seedGazetteerIfEmpty(db);
    assert.ok(seeded > 5000, `expected the full gazetteer, got ${seeded}`);

    const gaz = loadGazetteer(db);
    const { targets } = parseMessage('Сумщина: БпЛА курсом на Охтирку', gaz);
    assert.equal(targets.length, 1);
    assert.equal(targets[0]!.toName, 'Охтирка');
    assert.ok(targets[0]!.toLat !== null, 'a seeded name must carry coordinates');
  });

  test('inflected forms are regenerated, not shipped', () => {
    const db = memoryDb();
    seedGazetteerIfEmpty(db);
    const gaz = loadGazetteer(db);
    // Genitive and accusative of names that are not in the seed in those forms.
    assert.equal(gaz.resolve('Охтирку')?.name, 'Охтирка');
    assert.equal(gaz.resolve('Львова')?.name, 'Львів');
  });

  test('does nothing when the gazetteer is already populated', () => {
    const db = memoryDb();
    seedGazetteerIfEmpty(db);
    assert.equal(seedGazetteerIfEmpty(db), 0);
  });
});
