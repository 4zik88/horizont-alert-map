import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confidence, esc, hhmm, km, minutesAgo, sourceLink, typeWithCount } from '../src/format.js';
import { NOW, MIN } from './fixtures.js';

test('times are Kyiv wall clock', () => {
  assert.equal(hhmm(NOW), '21:00');
  assert.equal(hhmm(Date.UTC(2026, 0, 15, 6, 5)), '08:05');
});

test('minutes ago', () => {
  assert.equal(minutesAgo(NOW - 20_000, NOW), 'щойно');
  assert.equal(minutesAgo(NOW - 7 * MIN, NOW), '7 хв тому');
  assert.equal(minutesAgo(NOW - 125 * MIN, NOW), '2 год 5 хв тому');
  assert.equal(minutesAgo(NOW + MIN, NOW), 'щойно');
});

test('confidence as a percentage', () => {
  assert.equal(confidence(0.834), 'впевненість 83%');
  assert.equal(confidence(1.4), 'впевненість 100%');
});

test('distances are rounded, never falsely precise', () => {
  assert.equal(km(0.4), '<1');
  assert.equal(km(7.4), '7');
  assert.equal(km(23), '25');
});

test('source link points at the message', () => {
  assert.equal(sourceLink({ channel: 'kpszsu', messageId: 41870 }), 'https://t.me/kpszsu/41870');
});

test('type with count', () => {
  assert.equal(typeWithCount('uav', 1), 'Шахед');
  assert.equal(typeWithCount('cruise', 4), 'Крилата ×4');
});

test('escape', () => {
  assert.equal(esc('<img src=x onerror="a">'), '&lt;img src=x onerror=&quot;a&quot;&gt;');
});
