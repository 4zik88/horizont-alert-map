import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoHistory, demoSnapshot } from '../src/demo.js';
import { regionAlertStates } from '../src/regions.js';
import { isTrackStale, trackForecast } from '../src/targets.js';
import { MIN, NOW } from './fixtures.js';

test('demo covers every target type and every point kind', () => {
  const s = demoSnapshot(NOW);
  const types = new Set(s.tracks.map((t) => t.type));
  for (const t of ['uav', 'jet_uav', 'cruise', 'ballistic', 'kab', 'aviation', 'recon', 'unknown']) assert.ok(types.has(t as never), t);
  const kinds = new Set(s.tracks.map((t) => t.last.kind));
  for (const k of ['position', 'destination', 'launch']) assert.ok(kinds.has(k as never), k);
  assert.ok(s.tracks.some((t) => isTrackStale(t, NOW)), 'a stale one');
  const ballistic = s.tracks.find((t) => t.type === 'ballistic')!;
  assert.equal(trackForecast(ballistic, NOW).length, 0);
});

test('demo alerts cover raion, oblast and hromada, and one source is down', () => {
  const s = demoSnapshot(NOW);
  const levels = new Set(s.alerts.map((a) => a.level));
  assert.deepEqual([...levels].sort(), ['hromada', 'oblast', 'raion']);
  const st = regionAlertStates(s.alerts);
  assert.equal(st.get('oblast:kyivska')?.level, 1);
  assert.equal(st.get('oblast:dnipropetrovska')?.level, 2);
  assert.ok(s.sources.some((x) => !x.healthy));
});

test('demo history only shows what was known at that moment', () => {
  const at = NOW - 100 * MIN;
  const h = demoHistory(NOW, at);
  assert.equal(h.seq, 0);
  assert.ok(h.tracks.every((t) => t.lastSeenAt <= at && t.path.every((p) => p.at <= at)));
  assert.ok(h.alerts.some((a) => a.regionId === 'oblast:zaporizka'), 'an alert that has since ended');
  assert.ok(h.alerts.every((a) => a.startedAt <= at));
});
