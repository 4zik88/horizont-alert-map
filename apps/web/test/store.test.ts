import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerMessage, Snapshot } from '@horizont/contract';
import { emptyState, fromSnapshot, liveView, prune, reduce, toSnapshot } from '../src/store.js';
import { alert, MIN, NOW, track } from './fixtures.js';

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  seq: 10, at: NOW, alerts: [alert()], tracks: [track()],
  sources: [{ source: 'kpszsu', lastSuccessAt: NOW, healthy: true }], ...over,
});
const ev = (seq: number, e: Extract<ServerMessage, { t: 'event' }>['e']): ServerMessage => ({ t: 'event', seq, at: NOW + seq, e });

test('a snapshot frame replaces the state', () => {
  const r = reduce(emptyState(), { t: 'snapshot', ...snap() });
  assert.equal(r.kind, 'applied');
  assert.equal(r.state.seq, 10);
  assert.equal(r.state.alerts.size, 1);
  assert.equal(r.state.tracks.size, 1);
});

test('ended alerts in a snapshot are not live', () => {
  const s = fromSnapshot(snap({ alerts: [alert(), alert({ id: 2, endedAt: NOW - MIN })] }));
  assert.deepEqual([...s.alerts.keys()], [1]);
});

test('the next event applies and advances seq; the state is not mutated', () => {
  const s = fromSnapshot(snap());
  const r = reduce(s, ev(11, { type: 'alert.started', alert: alert({ id: 5, regionId: 'raion:kyivska:бучанський', level: 'raion' }) }));
  assert.equal(r.kind, 'applied');
  assert.equal(r.state.seq, 11);
  assert.equal(r.state.alerts.size, 2);
  assert.equal(s.alerts.size, 1);
});

test('alert.started upserts by id', () => {
  const s = fromSnapshot(snap());
  const r = reduce(s, ev(11, { type: 'alert.started', alert: alert({ areas: ['Біла Церква'] }) }));
  assert.equal(r.state.alerts.size, 1);
  assert.deepEqual(r.state.alerts.get(1)?.areas, ['Біла Церква']);
});

test('alert.ended drops the alert from the live view', () => {
  const r = reduce(fromSnapshot(snap()), ev(11, { type: 'alert.ended', alertId: 1, endedAt: NOW }));
  assert.equal(r.kind, 'applied');
  assert.equal(liveView(r.state, NOW).alerts.length, 0);
});

test('track.observed upserts and track.revised replaces or removes', () => {
  let s = fromSnapshot(snap());
  s = reduce(s, ev(11, { type: 'track.observed', track: track({ id: 2 }) })).state;
  assert.equal(s.tracks.size, 2);
  s = reduce(s, ev(12, { type: 'track.revised', trackId: 2, track: track({ id: 2, count: 7 }) })).state;
  assert.equal(s.tracks.get(2)?.count, 7);
  s = reduce(s, ev(13, { type: 'track.revised', trackId: 2, track: null })).state;
  assert.equal(s.tracks.has(2), false);
  assert.equal(s.seq, 13);
});

test('source.status upserts by source name', () => {
  const s = reduce(fromSnapshot(snap()), ev(11, { type: 'source.status', source: { source: 'kpszsu', lastSuccessAt: NOW, healthy: false } })).state;
  assert.equal(s.sources.size, 1);
  assert.equal(s.sources.get('kpszsu')?.healthy, false);
});

test('a skipped seq is reported as a gap and not applied', () => {
  const s = fromSnapshot(snap());
  const r = reduce(s, ev(13, { type: 'alert.ended', alertId: 1, endedAt: NOW }));
  assert.equal(r.kind, 'gap');
  assert.equal(r.state.seq, 10);
  assert.equal(r.state.alerts.size, 1);
});

test('duplicate or old events are ignored', () => {
  const s = fromSnapshot(snap());
  assert.equal(reduce(s, ev(10, { type: 'alert.ended', alertId: 1, endedAt: NOW })).kind, 'ignored');
  assert.equal(reduce(s, ev(3, { type: 'alert.ended', alertId: 1, endedAt: NOW })).kind, 'ignored');
});

test('pong changes nothing', () => {
  const s = fromSnapshot(snap());
  const r = reduce(s, { t: 'pong' });
  assert.equal(r.kind, 'pong');
  assert.equal(r.state, s);
});

test('the event time advances "updated"', () => {
  const r = reduce(fromSnapshot(snap()), ev(11, { type: 'track.observed', track: track({ id: 3 }) }));
  assert.equal(r.state.at, NOW + 11);
});

test('tracks older than three hours leave the live view and are pruned', () => {
  const old = track({ id: 9, lastSeenAt: NOW - 200 * MIN });
  const s = fromSnapshot(snap({ tracks: [track(), old] }));
  assert.equal(liveView(s, NOW).tracks.length, 1);
  assert.equal(prune(s, NOW).tracks.size, 1);
});

test('toSnapshot round-trips', () => {
  const s = fromSnapshot(snap());
  assert.deepEqual(toSnapshot(s), snap());
});
