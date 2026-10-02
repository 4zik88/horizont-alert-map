import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffMs } from '../src/connection.js';
import { SLIDER_MAX, sliderToTime, sourcesSummary, timeToSlider } from '../src/status.js';
import { MIN, NOW } from './fixtures.js';

test('any unhealthy source is a warning', () => {
  const ok = sourcesSummary([{ source: 'kpszsu', lastSuccessAt: NOW, healthy: true }]);
  assert.equal(ok.level, 'ok');
  const warn = sourcesSummary([
    { source: 'kpszsu', lastSuccessAt: NOW, healthy: true },
    { source: 'sectorv666', lastSuccessAt: NOW - 14 * MIN, healthy: false },
  ]);
  assert.equal(warn.level, 'warn');
  assert.match(warn.short, /sectorv666/);
  assert.match(warn.detail, /@sectorv666: збій \(востаннє 20:46\)/);
  assert.equal(sourcesSummary([]).level, 'warn');
  assert.equal(sourcesSummary([{ source: 'a', lastSuccessAt: null, healthy: false }]).level, 'bad');
});

test('the slider spans three hours and its right end is now', () => {
  assert.equal(SLIDER_MAX, 180);
  assert.equal(sliderToTime(SLIDER_MAX, NOW), NOW);
  assert.equal(sliderToTime(0, NOW), NOW - 180 * MIN);
  assert.equal(timeToSlider(NOW - 60 * MIN, NOW), 120);
  assert.equal(timeToSlider(NOW - 999 * MIN, NOW), 0);
});

test('reconnect backoff grows and is capped', () => {
  assert.equal(backoffMs(0, 0.5), 1000);
  assert.equal(backoffMs(3, 0.5), 8000);
  assert.equal(backoffMs(20, 0.5), 30000);
  assert.ok(backoffMs(20, 1) <= 37500);
});
