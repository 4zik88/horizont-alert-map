import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markerLabel, placeLine, regionPopupHtml, trackPopupHtml } from '../src/popup.js';
import { regionAlertStates } from '../src/regions.js';
import { alert, NOW, track } from './fixtures.js';

test('a destination is labelled as a course, not a position', () => {
  const t = track({}, { kind: 'destination', placeName: 'Бровари' });
  assert.equal(markerLabel(t), '→ Шахед');
  assert.equal(placeLine(t), 'курс на Бровари · ще не там');
});

test('a launch is never presented as a target position', () => {
  const t = track({}, { kind: 'launch', placeName: 'Приморсько-Ахтарськ' });
  assert.equal(placeLine(t), 'місце пуску: Приморсько-Ахтарськ · не ціль');
  assert.equal(placeLine(track({}, { relation: 'past', placeName: 'Канів' })), 'місце: Канів (повз)');
});

test('the target popup has type, count, time, confidence, source and the open-source note', () => {
  const html = trackPopupHtml(track({ count: 3, confidence: 0.86 }, { count: 3 }), NOW);
  assert.match(html, /Шахед \/ БпЛА/);
  assert.match(html, /×3/);
  assert.match(html, /2 хв тому/);
  assert.match(html, /впевненість 86%/);
  assert.match(html, /href="https:\/\/t\.me\/kpszsu\/100"/);
  assert.match(html, /дані з відкритих джерел/);
});

test('popup text from the wire is escaped', () => {
  const html = trackPopupHtml(track({}, { placeName: '<script>x</script>' }), NOW);
  assert.doesNotMatch(html, /<script>/);
});

test('a hromada alert tooltip lists the areas', () => {
  const s = regionAlertStates([alert({ level: 'hromada', severity: 'partial', areas: ['Бровари', 'Велика Димерка'] })]);
  const html = regionPopupHtml('Київська обл.', 'kyivska', s.get('oblast:kyivska'), NOW);
  assert.match(html, /Тривога в окремих громадах/);
  assert.match(html, /Під тривогою: Бровари, Велика Димерка/);
  assert.match(regionPopupHtml('Київська обл.', 'kyivska', undefined, NOW), /Тривоги немає/);
});
