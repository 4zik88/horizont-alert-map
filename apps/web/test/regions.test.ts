import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertAreas, bbox, filterToOblast, pointInGeometry, regionAlertStates, type RegionCollection } from '../src/regions.js';
import { alert, NOW, track } from './fixtures.js';

test('raion alert is red on the raion', () => {
  const s = regionAlertStates([alert({ regionId: 'raion:kharkivska:харківський', oblast: 'kharkivska', level: 'raion' })]);
  assert.equal(s.get('raion:kharkivska:харківський')?.level, 2);
  assert.equal(s.has('oblast:kharkivska'), false);
});

test('oblast full is red on the oblast; hromada is yellow with areas', () => {
  const s = regionAlertStates([
    alert({ id: 1, regionId: 'oblast:dnipropetrovska', oblast: 'dnipropetrovska' }),
    alert({ id: 2, level: 'hromada', severity: 'partial', areas: ['Бровари', 'Бровари', 'Велика Димерка'] }),
  ]);
  assert.equal(s.get('oblast:dnipropetrovska')?.level, 2);
  assert.equal(s.get('oblast:kyivska')?.level, 1);
  assert.deepEqual(alertAreas(s.get('oblast:kyivska')), ['Бровари', 'Велика Димерка']);
});

test('red wins over yellow on the same oblast', () => {
  const s = regionAlertStates([
    alert({ id: 2, level: 'hromada', severity: 'partial', areas: ['Бровари'] }),
    alert({ id: 3, level: 'oblast', severity: 'full' }),
  ]);
  assert.equal(s.get('oblast:kyivska')?.level, 2);
  assert.equal(s.get('oblast:kyivska')?.alerts.length, 2);
});

test('ended alerts paint nothing', () => {
  assert.equal(regionAlertStates([alert({ endedAt: NOW })]).size, 0);
});

const square = (x0: number, y0: number, x1: number, y1: number) => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] as [number, number][][];
const REGIONS: RegionCollection = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { id: 'oblast:kyivska', kind: 'oblast', oblast: 'kyivska' }, geometry: { type: 'Polygon', coordinates: square(29, 49, 32, 51.5) } },
    { type: 'Feature', properties: { id: 'oblast:odeska', kind: 'oblast', oblast: 'odeska' }, geometry: { type: 'MultiPolygon', coordinates: [square(28, 45, 31, 47.5)] } },
  ],
};

test('point in polygon and multipolygon', () => {
  assert.equal(pointInGeometry(30.5, 50.4, REGIONS.features[0]!.geometry), true);
  assert.equal(pointInGeometry(35, 50.4, REGIONS.features[0]!.geometry), false);
  assert.equal(pointInGeometry(30.7, 46.5, REGIONS.features[1]!.geometry), true);
});

test('bbox of an oblast', () => {
  assert.deepEqual(bbox([REGIONS.features[0]!]), [29, 49, 32, 51.5]);
});

test('only my oblast keeps its alerts and the tracks inside it (Kyiv city maps to Kyiv oblast)', () => {
  const view = {
    alerts: [alert(), alert({ id: 2, regionId: 'oblast:odeska', oblast: 'odeska' }), alert({ id: 3, regionId: 'oblast:kyiv', oblast: 'kyiv' })],
    tracks: [
      track({ id: 1 }, { lat: 50.4, lon: 30.5 }),
      track({ id: 2 }, { lat: 46.5, lon: 30.7 }),
      // Left the oblast, but its path crossed it.
      track({ id: 3, path: [{ lat: 50.0, lon: 31.5, at: NOW, kind: 'position' }] }, { lat: 50.0, lon: 33 }),
    ],
  };
  const f = filterToOblast(view, 'kyivska', REGIONS);
  assert.deepEqual(f.alerts.map((a) => a.id), [1, 3]);
  assert.deepEqual(f.tracks.map((t) => t.id), [1, 3]);
  assert.deepEqual(filterToOblast(view, 'kyiv', REGIONS).tracks.map((t) => t.id), [1, 3]);
});
