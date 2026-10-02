import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { loadGazetteer } from '../src/db/gazetteer.js';
import { parseMessage } from '@horizont/parser';
import { seedGazetteerIfEmpty } from '../src/db/seed.js';
import { scalar, useTestDb } from './helpers.js';

const db = useTestDb();

describe('gazetteer seed', () => {
  /*
   * A fresh Railway volume has empty tables and the service still reports healthy,
   * so an unseeded deploy fails silently: every message goes to the feed as text and
   * the map draws nothing. This is the test that says the deploy works at all.
   */
  test('an empty database can resolve place names after seeding', async () => {
    assert.equal(await scalar(db(), 'SELECT COUNT(*) FROM toponyms'), 0);

    const seeded = await seedGazetteerIfEmpty(db());
    assert.ok(seeded > 5000, `expected the full gazetteer, got ${seeded}`);

    const gaz = await loadGazetteer(db());
    const { targets } = parseMessage('Сумщина: БпЛА курсом на Охтирку', gaz);
    assert.equal(targets.length, 1);
    assert.equal(targets[0]!.toName, 'Охтирка');
    assert.ok(targets[0]!.toLat !== null, 'a seeded name must carry coordinates');
  });

  test('inflected forms are regenerated, not shipped', async () => {
    await seedGazetteerIfEmpty(db());
    const gaz = await loadGazetteer(db());
    // Genitive and accusative of names that are not in the seed in those forms.
    assert.equal(gaz.resolve('Охтирку')?.name, 'Охтирка');
    assert.equal(gaz.resolve('Львова')?.name, 'Львів');
  });

  test('does nothing when the gazetteer is already populated', async () => {
    await seedGazetteerIfEmpty(db());
    assert.equal(await seedGazetteerIfEmpty(db()), 0);
  });
});
