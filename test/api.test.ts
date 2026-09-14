import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { MapApi } from '../src/http/api.js';
import { Repo, type TargetParams } from '../src/db/repo.js';
import { memoryDb } from './helpers.js';

const NOW = 1_700_000_000_000;

function seed(): MapApi {
  const db = memoryDb();
  const repo = new Repo(db);

  repo.ensureChannel('kpszsu');
  repo.tryInsertMessage({
    channel: 'kpszsu',
    messageId: 1,
    postedAt: NOW - 60_000,
    fetchedAt: NOW,
    text: 'дві цілі',
    textHtml: 'дві цілі',
    contentHash: 'h1',
    hasMedia: 0,
    isSensitive: 0,
  });
  const messageId = (db.prepare('SELECT id FROM messages').get() as { id: number }).id;

  const base: Omit<TargetParams, 'relation' | 'toName' | 'toLat' | 'toLon' | 'fromName' | 'fromLat' | 'fromLon'> = {
    messageId,
    type: 'uav',
    rawType: null,
    count: 1,
    oblast: null,
    courseDeg: null,
    confidence: 0.9,
    source: 'rules',
    observedAt: NOW - 60_000,
    createdAt: NOW,
  };

  repo.saveTargets(messageId, [
    // A target in flight: it has a destination.
    { ...base, relation: 'towards', toName: 'Охтирка', toLat: 50.3, toLon: 34.9, fromName: null, fromLat: null, fromLon: null },
    // A launch: an origin and nothing else.
    { ...base, relation: 'launch', toName: null, toLat: null, toLon: null, fromName: 'Гвардійське', fromLat: 45.1, fromLon: 34.0 },
  ], 'parsed', NOW, 1);

  return new MapApi(db, { targetWindowMs: 3_600_000, feedLimit: 50 });
}

describe('MapApi — launches are not targets', () => {
  /*
   * A launch site is where something started, not where it is. Keeping the two in
   * separate collections is what stops a launch from ever being drawn as a position,
   * which is exactly the bug that put a drone icon on a Crimean airbase.
   */
  test('a launch never appears among the targets', () => {
    const state = seed().state(NOW);
    assert.equal(state.targets.length, 1);
    assert.equal(state.targets[0]!.label, 'Охтирка');
  });

  test('a launch is reported at its origin', () => {
    const state = seed().state(NOW);
    assert.equal(state.launches.length, 1);
    assert.equal(state.launches[0]!.label, 'Гвардійське');
    assert.equal(state.launches[0]!.lat, 45.1);
  });
});
