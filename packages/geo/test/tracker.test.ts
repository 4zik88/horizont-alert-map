import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_LINK, destination, linkSighting, nextHeading, type OpenTrack, type Sighting } from '../src/index.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 2, 20, 0);
const opts = { ...DEFAULT_LINK, speedKmh: (t: string) => (t === 'cruise' ? 800 : 180) };
const KYIV = { lat: 50.45, lon: 30.52 };

const track = (over: Partial<OpenTrack> = {}): OpenTrack => ({
  id: 1, type: 'uav', ...KYIV, lastKind: 'position', lastSeenAt: T0, headingDeg: null, ...over,
});
const sight = (over: Partial<Sighting> = {}): Sighting => ({
  type: 'uav', ...KYIV, kind: 'position', headingDeg: null, observedAt: T0 + 10 * MIN, ...over,
});

test('a plausible hop joins the track', () => {
  const p = destination(KYIV.lat, KYIV.lon, 270, 40); // 40 km in 10 min: within 180*1/6*1.5+30 = 75
  assert.equal(linkSighting([track()], sight(p), opts), 1);
});

test('a hop too far for the speed starts a new track', () => {
  const p = destination(KYIV.lat, KYIV.lon, 270, 90);
  assert.equal(linkSighting([track()], sight(p), opts), null);
});

test('the same distance is fine for a cruise missile', () => {
  const p = destination(KYIV.lat, KYIV.lon, 270, 90);
  assert.equal(linkSighting([track({ type: 'cruise' })], sight({ ...p, type: 'cruise' }), opts), 1);
});

test('different types never join', () => {
  assert.equal(linkSighting([track({ type: 'jet_uav' })], sight(), opts), null);
});

test('a hop against the track heading starts a new track', () => {
  const p = destination(KYIV.lat, KYIV.lon, 90, 40); // flies east, track heads west
  assert.equal(linkSighting([track({ headingDeg: 270 })], sight(p), opts), null);
  const q = destination(KYIV.lat, KYIV.lon, 260, 40);
  assert.equal(linkSighting([track({ headingDeg: 270 })], sight(q), opts), 1);
});

test('conflicting stated headings never join', () => {
  assert.equal(linkSighting([track({ headingDeg: 0 })], sight({ headingDeg: 180 }), opts), null);
});

test('a track silent for more than 25 minutes is closed', () => {
  assert.equal(linkSighting([track()], sight({ observedAt: T0 + 26 * MIN }), opts), null);
});

test('a slightly out-of-order report still joins', () => {
  assert.equal(linkSighting([track()], sight({ observedAt: T0 - 3 * MIN }), opts), 1);
});

test('launches only merge with the same launch site', () => {
  assert.equal(linkSighting([track()], sight({ kind: 'launch' }), opts), null);
  assert.equal(linkSighting([track({ lastKind: 'launch' })], sight({ kind: 'position' }), opts), null);
  assert.equal(linkSighting([track({ lastKind: 'launch' })], sight({ kind: 'launch' }), opts), 1);
});

test('the closest candidate wins', () => {
  const near = track({ id: 2, ...destination(KYIV.lat, KYIV.lon, 0, 5) });
  const far = track({ id: 3, ...destination(KYIV.lat, KYIV.lon, 0, 30) });
  assert.equal(linkSighting([far, near], sight(), opts), 2);
});

test('heading: stated first, then travel between positions, else unchanged', () => {
  const p = destination(KYIV.lat, KYIV.lon, 300, 40);
  assert.equal(nextHeading(track(), sight({ headingDeg: 45 })), 45);
  assert.ok(Math.abs(nextHeading(track(), sight(p))! - 300) < 1);
  assert.equal(nextHeading(track({ headingDeg: 10 }), sight({ ...p, kind: 'destination' })), 10);
});
