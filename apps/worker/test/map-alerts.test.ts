import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { geoDataPath, raionsOf } from '@horizont/geo/node';
import { desiredAlerts } from '../src/map/alerts.js';

const regionIds = new Set(
  (JSON.parse(readFileSync(geoDataPath('map-regions.geojson'), 'utf8')) as {
    features: { properties: { id: string } }[];
  }).features.map((f) => f.properties.id),
);

test('an oblast-wide alert is one red oblast', () => {
  assert.deepEqual(desiredAlerts(new Map([['sumska', 'full']]), new Map()), [
    { regionId: 'oblast:sumska', oblast: 'sumska', level: 'oblast', severity: 'full', areas: [] },
  ]);
});

test('named raions are red on their own; hromadas make the oblast yellow, listed', () => {
  const out = desiredAlerts(
    new Map([['sumska', 'partial'], ['odeska', 'none']]),
    new Map([['sumska', ['сумський', 'липецька', 'охтирський', 'липецька']]]),
  );
  assert.deepEqual(out.map((a) => [a.regionId, a.level, a.severity, a.areas]), [
    ['raion:sumska:сумський', 'raion', 'full', []],
    ['raion:sumska:охтирський', 'raion', 'full', []],
    ['oblast:sumska', 'hromada', 'partial', ['липецька']],
  ]);
});

test('a partial alert that names nothing is a yellow oblast', () => {
  assert.deepEqual(desiredAlerts(new Map([['kharkivska', 'partial']]), new Map()).map((a) => [a.regionId, a.severity]), [
    ['oblast:kharkivska', 'partial'],
  ]);
});

test('every region id the mapping can produce has a polygon on the map, Kyiv city included', () => {
  for (const key of ['kyiv', 'kyivska', 'sumska', 'krym', 'odeska']) {
    assert.ok(regionIds.has(`oblast:${key}`), key);
    for (const r of raionsOf(key)) assert.ok(regionIds.has(`raion:${key}:${r.match}`), `${key}/${r.match}`);
  }
});
