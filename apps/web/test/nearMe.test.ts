import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nearMe } from '../src/nearMe.js';
import { MIN, NOW, track } from './fixtures.js';

const KYIV = { lat: 50.45, lon: 30.52 };

test('a position heading at the user gets an approximate time and a pass distance', () => {
  // Myronivka, heading north-north-west towards Kyiv.
  const t = track({}, { lat: 49.66, lon: 30.98, headingDeg: 340, observedAt: NOW - MIN });
  const items = nearMe([{ ...t, lastSeenAt: NOW - MIN }], KYIV, NOW);
  assert.equal(items.length, 1);
  const i = items[0]!;
  assert.equal(i.kind, 'approach');
  assert.match(i.text, /^Шахед · ~\d+ хв до вас \(орієнтовно\), пройде за (<1|~\d+) км$/);
});

test('a position moving away is not listed', () => {
  const t = track({}, { lat: 49.66, lon: 30.98, headingDeg: 160 });
  assert.equal(nearMe([t], KYIV, NOW).length, 0);
});

test('a path passing further than 40 km is not listed', () => {
  const t = track({}, { lat: 49.66, lon: 33.5, headingDeg: 0 });
  assert.equal(nearMe([t], KYIV, NOW).length, 0);
});

test('a destination within 40 km is named with a distance and no time', () => {
  const t = track({ count: 2 }, { kind: 'destination', lat: 50.51, lon: 30.79, placeName: 'Бровари', headingDeg: 205, count: 2 });
  const items = nearMe([t], KYIV, NOW);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, 'destination');
  assert.match(items[0]!.text, /^Шахед ×2 курс на Бровари \(\d+ км від вас\)$/);
  assert.doesNotMatch(items[0]!.text, /хв/);
});

test('a far destination, a launch, a stale report and a ballistic are not listed', () => {
  const far = track({ id: 1 }, { kind: 'destination', lat: 48.46, lon: 35.05 });
  const launch = track({ id: 2 }, { kind: 'launch', lat: 50.4, lon: 30.5 });
  const stale = track({ id: 3, lastSeenAt: NOW - 30 * MIN }, { lat: 50.2, lon: 30.5, headingDeg: 0, observedAt: NOW - 30 * MIN });
  const ballistic = track({ id: 4, type: 'ballistic' }, { type: 'ballistic', lat: 50.2, lon: 30.5, headingDeg: 0 });
  assert.equal(nearMe([far, launch, stale, ballistic], KYIV, NOW).length, 0);
});

test('approaching targets come first, soonest first, then destinations', () => {
  const slow = track({ id: 1 }, { lat: 49.9, lon: 30.6, headingDeg: 355 });
  const soon = track({ id: 2 }, { lat: 50.2, lon: 30.55, headingDeg: 355 });
  const dest = track({ id: 3 }, { kind: 'destination', lat: 50.51, lon: 30.79, placeName: 'Бровари' });
  const ids = nearMe([dest, slow, soon], KYIV, NOW).map((i) => i.trackId);
  assert.deepEqual(ids, [2, 1, 3]);
});
