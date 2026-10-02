import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  DEFAULT_PROXIMITY,
  angleDelta,
  matchTarget,
  type ProximityOptions,
  type TargetView,
  type UserView,
} from '../src/notify/proximity.js';
import { TYPE_SPEED_KMH } from '@horizont/parser';

const NOW = 1_700_000_000_000;
const opts: ProximityOptions = { ...DEFAULT_PROXIMITY, now: NOW };

// Okhtyrka, and a user 20 km away.
const OKHTYRKA = { lat: 50.31, lon: 34.89 };
const user: UserView = { chatId: 1, lat: 50.31, lon: 34.6, radiusKm: 40 };

const target = (over: Partial<TargetView> = {}): TargetView => ({
  id: 1,
  type: 'uav',
  toName: 'Охтирка',
  toLat: OKHTYRKA.lat,
  toLon: OKHTYRKA.lon,
  fromLat: null,
  fromLon: null,
  courseDeg: null,
  confidence: 0.95,
  observedAt: NOW - 60_000,
  ...over,
});

describe('angleDelta', () => {
  test('is the shortest way round the compass', () => {
    assert.equal(angleDelta(10, 350), 20);
    assert.equal(angleDelta(350, 10), 20);
    assert.equal(angleDelta(0, 180), 180);
    assert.equal(angleDelta(90, 90), 0);
  });
});

describe('matchTarget — in radius', () => {
  test('warns when the destination is inside the radius', () => {
    const match = matchTarget(target(), user, opts);
    assert.equal(match?.reason, 'in_radius');
    assert.ok(match!.distanceKm < 40);
  });

  test('stays quiet when it is outside the radius', () => {
    assert.equal(matchTarget(target(), { ...user, radiusKm: 10 }, opts), undefined);
  });

  test('respects each user\'s own radius', () => {
    assert.ok(matchTarget(target(), { ...user, radiusKm: 25 }, opts));
    assert.equal(matchTarget(target(), { ...user, radiusKm: 15 }, opts), undefined);
  });
});

describe('matchTarget — guards against false alarms', () => {
  // A guessed location must never buzz someone's phone at 03:00.
  test('ignores low-confidence targets', () => {
    assert.equal(matchTarget(target({ confidence: 0.5 }), user, opts), undefined);
    assert.ok(matchTarget(target({ confidence: 0.6 }), user, opts));
  });

  test('ignores stale targets', () => {
    assert.equal(matchTarget(target({ observedAt: NOW - 31 * 60_000 }), user, opts), undefined);
    assert.ok(matchTarget(target({ observedAt: NOW - 29 * 60_000 }), user, opts));
  });

  test('ignores targets with no position at all', () => {
    assert.equal(
      matchTarget(target({ toLat: null, toLon: null }), user, opts),
      undefined,
    );
  });
});

describe('matchTarget — heading towards', () => {
  // Target ~50 km west of the user, flying due east: about 17 minutes out at drone
  // speed, so inside the warning horizon but well outside a 10 km radius.
  const inbound = target({
    toName: 'Гадяч',
    fromLat: 50.31, fromLon: 33.9,
    toLat: 50.31, toLon: 34.2,
    courseDeg: 90,
    confidence: 0.9,
  });

  test('warns when the course points at the user, before it is in range', () => {
    const far: UserView = { chatId: 1, lat: 50.31, lon: 34.6, radiusKm: 10 };
    const match = matchTarget(inbound, far, opts);
    assert.equal(match?.reason, 'heading_towards');
    assert.ok(match!.distanceKm > 10, 'it is still outside the radius');
  });

  // The horizon is deliberate: a drone 33 minutes out may well change course, and a
  // warning that early costs more in false alarms than it buys in notice.
  test('stays quiet beyond the warning horizon', () => {
    const early = { ...inbound, fromLon: 33.2, toLon: 33.5 };
    const far: UserView = { chatId: 1, lat: 50.31, lon: 34.6, radiusKm: 10 };
    assert.equal(matchTarget(early, far, opts), undefined);
  });

  test('stays quiet when the course points away', () => {
    const outbound = { ...inbound, courseDeg: 270 };
    assert.equal(matchTarget(outbound, { ...user, radiusKm: 10 }, opts), undefined);
  });

  test('stays quiet outside the course corridor', () => {
    // 60 degrees off the bearing to the user is not "towards" them.
    const askew = { ...inbound, courseDeg: 150 };
    assert.equal(matchTarget(askew, { ...user, radiusKm: 10 }, opts), undefined);
  });

  // A drone on the far side of the country is not news.
  test('stays quiet when the target is nowhere near', () => {
    const distant = { ...inbound, fromLon: 24.0, toLon: 25.0 };
    assert.equal(matchTarget(distant, { ...user, radiusKm: 10 }, opts), undefined);
  });

  // A jet UAV covers over three times the ground of a propeller one in the same
  // time, so the same geometry should warn for one and not the other.
  test('scales the lookahead by how fast the target actually flies', () => {
    const far: UserView = { chatId: 1, lat: 50.31, lon: 35.6, radiusKm: 10 };
    const slow = { ...inbound, type: 'uav' as const };
    const fast = { ...inbound, type: 'cruise' as const };
    assert.equal(matchTarget(slow, far, opts), undefined);
    assert.ok(matchTarget(fast, far, opts), 'a cruise missile at that range is worth a warning');
  });

  test('needs a known origin before trusting a course', () => {
    const noOrigin = target({ courseDeg: 90, fromLat: null, fromLon: null });
    assert.equal(matchTarget(noOrigin, { ...user, radiusKm: 5 }, opts), undefined);
  });
});

/*
 * The reported bug: "Реактивний БпЛА, курс на Жашків, ~201 км від вас", read by a
 * reader in Kozyatyn who knows Zhashkiv is about a hundred kilometres away.
 *
 * Both numbers were real. 106 km is the distance to Zhashkiv; 201 km was the distance
 * to where the drone then was. The message printed the second under the name of the
 * first, so which fact you got depended on why the alert had fired.
 */
describe('matchTarget — which distance is which', () => {
  const KOZYATYN = { chatId: 1, lat: 49.716, lon: 28.8318, radiusKm: 40 };
  const ZHASHKIV = { lat: 49.243, lon: 30.105 };
  // South-east of the reader, beyond Zhashkiv, flying north-west at them.
  const ORIGIN = { lat: 48.5, lon: 31.6 };

  const jetTowardsZhashkiv = {
    id: 1,
    type: 'jet_uav' as const,
    toName: 'Жашків',
    toLat: ZHASHKIV.lat,
    toLon: ZHASHKIV.lon,
    fromLat: ORIGIN.lat,
    fromLon: ORIGIN.lon,
    courseDeg: 315,
    confidence: 0.9,
    observedAt: 1_000_000,
  };

  const opts = { ...DEFAULT_PROXIMITY, now: 1_000_000 };

  test('the printed distance belongs to the place that is named', () => {
    const match = matchTarget(jetTowardsZhashkiv, KOZYATYN, opts);

    assert.ok(match, 'a jet UAV pointed at the reader should match');
    assert.equal(match.reason, 'heading_towards');
    assert.ok(
      Math.abs(match.distanceKm - 106) < 5,
      `Zhashkiv is ~106 km from Kozyatyn, got ${Math.round(match.distanceKm)}`,
    );
  });

  test('where the target actually is stays available, separately', () => {
    const match = matchTarget(jetTowardsZhashkiv, KOZYATYN, opts)!;

    assert.ok(match.targetKm > match.distanceKm, 'the drone is further out than the town');
    assert.ok(Math.abs(match.targetKm - 232) < 15, `got ${Math.round(match.targetKm)}`);
  });

  test('the time to reach the reader is measured from the target, not the town', () => {
    const match = matchTarget(jetTowardsZhashkiv, KOZYATYN, opts)!;

    assert.ok(match.etaMin !== null);
    // 232 km at the jet-UAV cruise speed, not 106.
    const expected = (match.targetKm / TYPE_SPEED_KMH.jet_uav) * 60;
    assert.ok(Math.abs(match.etaMin - expected) < 0.01);
  });

  test('a target already in the radius reports no time to reach', () => {
    const overhead = { ...jetTowardsZhashkiv, toLat: 49.72, toLon: 28.84 };
    const match = matchTarget(overhead, KOZYATYN, opts)!;

    assert.equal(match.reason, 'in_radius');
    assert.equal(match.etaMin, null);
    assert.ok(match.distanceKm < 5, 'and the distance is to the named town');
  });

  test('with no destination named, the distance is to the target itself', () => {
    const unnamed = { ...jetTowardsZhashkiv, toName: null, toLat: null, toLon: null };
    const match = matchTarget(unnamed, KOZYATYN, opts)!;

    assert.equal(match.distanceKm, match.targetKm);
  });
});
