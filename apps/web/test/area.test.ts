import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nearMe } from '../src/nearMe.js';
import { markerLabel, placeLine } from '../src/popup.js';
import { trackForecast } from '../src/targets.js';
import { NOW, track } from './fixtures.js';

/*
 * Found live: "Реактивні БпЛА на півночі Чернігівщини, курс на південь" resolved to the
 * oblast and was drawn on Chernihiv city with a 600 km/h forecast toward Kyiv.
 */
const chernihivOblast = track({ type: 'jet_uav', lastSeenAt: NOW - 60_000 }, {
  type: 'jet_uav', kind: 'position', area: true, placeName: 'Чернігівська', lat: 51.5, lon: 31.29,
  headingDeg: 180, speedKmh: null, observedAt: NOW - 60_000,
});

test('an oblast-wide report is never projected', () => {
  assert.deepEqual(trackForecast(chernihivOblast, NOW), []);
});

test('it gives nobody a time or a distance', () => {
  const kyiv = { lat: 50.45, lon: 30.52 };
  const chernihiv = { lat: 51.5, lon: 31.29 };
  assert.deepEqual(nearMe([chernihivOblast], kyiv, NOW), []);
  assert.deepEqual(nearMe([chernihivOblast], chernihiv, NOW), []);
});

test('it says it is somewhere in the oblast, not at this spot', () => {
  assert.equal(markerLabel(chernihivOblast), '≈ Реакт. БпЛА');
  assert.match(placeLine(chernihivOblast), /десь у межах: Чернігівська обл\. · точне місце невідоме/);
});

test('the same report at a real place still gets its forecast', () => {
  const point = track({ type: 'jet_uav', lastSeenAt: NOW - 60_000 }, {
    type: 'jet_uav', kind: 'position', area: false, headingDeg: 180, observedAt: NOW - 60_000,
  });
  assert.equal(trackForecast(point, NOW).length, 3);
});
