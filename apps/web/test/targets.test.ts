import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comingFromBearing, fadeOpacity, markerModel, markerSize, offsetPx, tailSegments, trackForecast } from '../src/targets.js';
import { MIN, NOW, track } from './fixtures.js';

test('a fresh position with a heading and a speed gets 10/20/30-minute points', () => {
  const pts = trackForecast(track({}, { headingDeg: 0 }), NOW);
  assert.deepEqual(pts.map((p) => p.minutes), [10, 20, 30]);
  assert.ok(pts[0]!.lat > 49.66, 'north of the report');
});

test('no forecast for a destination, a launch, a ballistic, no heading, or a stale report', () => {
  assert.equal(trackForecast(track({}, { kind: 'destination' }), NOW).length, 0);
  assert.equal(trackForecast(track({}, { kind: 'launch' }), NOW).length, 0);
  assert.equal(trackForecast(track({ type: 'ballistic' }, { type: 'ballistic', headingDeg: 270 }), NOW).length, 0);
  assert.equal(trackForecast(track({ type: 'kab' }, { type: 'kab', headingDeg: 90 }), NOW).length, 0);
  assert.equal(trackForecast(track({}, { headingDeg: null }), NOW).length, 0);
  const stale = track({ lastSeenAt: NOW - 26 * MIN }, { observedAt: NOW - 26 * MIN });
  assert.equal(trackForecast(stale, NOW).length, 0);
});

test('staleness is measured from lastSeenAt', () => {
  assert.equal(markerModel(track({ lastSeenAt: NOW - 24 * MIN }), NOW).stale, false);
  assert.equal(markerModel(track({ lastSeenAt: NOW - 26 * MIN }), NOW).stale, true);
});

test('position is filled, destination hollow, launch a burst', () => {
  assert.equal(markerModel(track(), NOW).style, 'filled');
  assert.equal(markerModel(track({}, { kind: 'destination' }), NOW).style, 'hollow');
  const launch = markerModel(track({}, { kind: 'launch', headingDeg: 45 }), NOW);
  assert.equal(launch.style, 'launch');
  assert.equal(launch.rotation, null);
});

test('unknown heading is upright, never a made-up direction', () => {
  assert.equal(markerModel(track({}, { headingDeg: null }), NOW).rotation, null);
  assert.equal(markerModel(track({}, { headingDeg: 135 }), NOW).rotation, 135);
});

test('a destination marker sits on the side the target comes from', () => {
  const t = track({}, { kind: 'destination', headingDeg: 270 });
  assert.equal(markerModel(t, NOW).offsetBearing, 90);
  const [dx, dy] = offsetPx(90, 40);
  assert.equal(dx, 40);
  assert.equal(dy, 0);
  // No heading: an earlier reported position says where it comes from.
  const viaPath = track(
    { path: [{ lat: 50.91, lon: 31.12, at: NOW - 20 * MIN, kind: 'position' }, { lat: 50.51, lon: 30.79, at: NOW, kind: 'destination' }] },
    { kind: 'destination', headingDeg: null, lat: 50.51, lon: 30.79 },
  );
  const b = comingFromBearing(viaPath)!;
  assert.ok(b > 0 && b < 90, `north-east, got ${b}`);
  // Nothing known: no side is invented.
  assert.equal(comingFromBearing(track({}, { kind: 'destination', headingDeg: null })), null);
});

test('marker grows with count', () => {
  assert.equal(markerSize(1), 30);
  assert.ok(markerSize(4) > markerSize(2));
  assert.ok(markerSize(1000) <= 48);
});

test('tails fade with age and stop at an hour', () => {
  assert.equal(fadeOpacity(NOW, NOW), 0.9);
  assert.ok(fadeOpacity(NOW - 30 * MIN, NOW) < 0.9);
  assert.equal(fadeOpacity(NOW - 61 * MIN, NOW), 0);
  const t = track({
    path: [
      { lat: 49.0, lon: 32.0, at: NOW - 90 * MIN, kind: 'position' },
      { lat: 49.2, lon: 31.8, at: NOW - 50 * MIN, kind: 'position' },
      { lat: 49.4, lon: 31.4, at: NOW - 20 * MIN, kind: 'position' },
      { lat: 49.6, lon: 31.0, at: NOW - 2 * MIN, kind: 'position' },
    ],
  });
  const segs = tailSegments(t, NOW);
  assert.equal(segs.length, 2);
  assert.ok(segs[1]!.opacity > segs[0]!.opacity);
});

test('no tail is drawn to a place the target is only heading for', () => {
  const t = track({
    path: [
      { lat: 50.91, lon: 31.12, at: NOW - 20 * MIN, kind: 'position' },
      { lat: 50.51, lon: 30.79, at: NOW - 5 * MIN, kind: 'destination' },
    ],
  });
  assert.equal(tailSegments(t, NOW).length, 0);
});
