import { existsSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  angleDiff, approach, bearing, concerns, destination, distanceKm, forecast, isStale,
  type Motion,
} from '../src/index.js';
import { geoDataPath, raionAt } from '../src/node.js';


const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 2, 12, 0);
const KYIV = { lat: 50.45, lon: 30.52 };

test('destination and distance agree', () => {
  const p = destination(KYIV.lat, KYIV.lon, 135, 100);
  assert.ok(Math.abs(distanceKm(KYIV.lat, KYIV.lon, p.lat, p.lon) - 100) < 0.01);
  assert.ok(angleDiff(bearing(KYIV.lat, KYIV.lon, p.lat, p.lon), 135) < 0.5);
});

test('angleDiff wraps across north', () => {
  assert.equal(angleDiff(350, 10), 20);
  assert.equal(angleDiff(10, 350), 20);
  assert.equal(angleDiff(0, 180), 180);
});

test('a shahed forecast moves 27.5 km per 10 minutes at 165 km/h', () => {
  const m: Motion = { ...KYIV, headingDeg: 0, speedKmh: 165, observedAt: NOW };
  const pts = forecast(m, NOW);
  assert.deepEqual(pts.map((p) => p.minutes), [10, 20, 30]);
  const d30 = distanceKm(KYIV.lat, KYIV.lon, pts[2]!.lat, pts[2]!.lon);
  assert.ok(Math.abs(d30 - 82.5) < 0.1, `got ${d30}`);
  assert.ok(pts[2]!.lat > KYIV.lat);
});

test('no forecast without a heading, without a speed, or once stale', () => {
  const base: Motion = { ...KYIV, headingDeg: 90, speedKmh: 165, observedAt: NOW };
  assert.equal(forecast({ ...base, headingDeg: null }, NOW).length, 0);
  assert.equal(forecast({ ...base, speedKmh: null }, NOW).length, 0); // ballistic
  assert.equal(forecast(base, NOW + 26 * MIN).length, 0);
  assert.equal(forecast(base, NOW + 24 * MIN).length, 3);
  assert.equal(isStale(base, NOW + 25 * MIN), false);
  assert.equal(isStale(base, NOW + 25 * MIN + 1), true);
});

test('a target heading straight at the user arrives on time', () => {
  // 55 km north of Kyiv, flying south at 165 km/h -> 20 minutes.
  const start = destination(KYIV.lat, KYIV.lon, 0, 55);
  const m: Motion = { ...start, headingDeg: 180, speedKmh: 165, observedAt: NOW };
  const a = approach(m, KYIV, NOW)!;
  assert.ok(a.closestKm < 1, `closest ${a.closestKm}`);
  assert.ok(Math.abs(a.etaMin - 20) < 0.5, `eta ${a.etaMin}`);
  assert.equal(concerns(a), true);
});

test('time already elapsed since the report is subtracted from the ETA', () => {
  const start = destination(KYIV.lat, KYIV.lon, 0, 55);
  const m: Motion = { ...start, headingDeg: 180, speedKmh: 165, observedAt: NOW - 5 * MIN };
  const a = approach(m, KYIV, NOW)!;
  assert.ok(Math.abs(a.etaMin - 15) < 0.5, `eta ${a.etaMin}`);
});

test('a path passing 30 km to the side concerns the user; 60 km does not', () => {
  const near = destination(KYIV.lat, KYIV.lon, 270, 30);
  const from = destination(near.lat, near.lon, 0, 40);
  const a = approach({ ...from, headingDeg: 180, speedKmh: 165, observedAt: NOW }, KYIV, NOW)!;
  assert.ok(Math.abs(a.closestKm - 30) < 1, `closest ${a.closestKm}`);
  assert.equal(concerns(a), true);

  const far = destination(KYIV.lat, KYIV.lon, 270, 60);
  const from2 = destination(far.lat, far.lon, 0, 40);
  const b = approach({ ...from2, headingDeg: 180, speedKmh: 165, observedAt: NOW }, KYIV, NOW)!;
  assert.equal(concerns(b), false);
});

test('a target moving away is not approaching', () => {
  const start = destination(KYIV.lat, KYIV.lon, 0, 20);
  assert.equal(approach({ ...start, headingDeg: 0, speedKmh: 165, observedAt: NOW }, KYIV, NOW), undefined);
});

test('a far cruise missile can concern the user; a far shahed cannot within 30 minutes', () => {
  const start = destination(KYIV.lat, KYIV.lon, 90, 300);
  const cruise = approach({ ...start, headingDeg: 270, speedKmh: 800, observedAt: NOW }, KYIV, NOW)!;
  assert.ok(cruise.etaMin < 30);
  assert.equal(concerns(cruise), true);
  const shahed = approach({ ...start, headingDeg: 270, speedKmh: 165, observedAt: NOW }, KYIV, NOW)!;
  assert.ok(shahed.etaMin > 100);
  assert.equal(concerns(shahed), false);
});

test('geo data ships with the package and raion lookup reads it', () => {
  assert.ok(existsSync(geoDataPath('raions.geojson')));
  assert.ok(existsSync(geoDataPath('gazetteer.json')));
  // Kozyatyn sits in Khmilnyk raion of Vinnytsia oblast.
  const r = raionAt(49.716, 28.833);
  assert.ok(r, 'expected a raion');
  assert.match(r!.name, /Хмільницький/);
});
