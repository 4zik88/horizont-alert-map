import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  failureLogLevel,
  gapFillAdvanced,
  needsGapFill,
  nextDelay,
} from '../src/telegram/policy.js';

const OPTS = { baseMs: 20_000, jitterPct: 0.15, maxBackoffMs: 300_000 };
const mid = () => 0.5; // jitter factor 1.0

describe('nextDelay', () => {
  test('uses the base interval when healthy', () => {
    assert.equal(nextDelay(0, OPTS, mid), 20_000);
  });

  test('backs off exponentially and then caps', () => {
    assert.equal(nextDelay(1, OPTS, mid), 40_000);
    assert.equal(nextDelay(2, OPTS, mid), 80_000);
    assert.equal(nextDelay(3, OPTS, mid), 160_000);
    assert.equal(nextDelay(4, OPTS, mid), 300_000, 'capped at maxBackoffMs');
    assert.equal(nextDelay(99, OPTS, mid), 300_000, 'stays finite for absurd counts');
  });

  test('keeps jitter inside the configured band', () => {
    for (const rng of [() => 0, () => 1, () => 0.37]) {
      const delay = nextDelay(0, OPTS, rng);
      assert.ok(delay >= 17_000 && delay <= 23_000, `${delay} outside +/-15%`);
    }
  });
});

describe('needsGapFill', () => {
  test('does nothing on a cold start', () => {
    // An empty DB must take the visible page, not walk the channel's whole history.
    assert.equal(needsGapFill(0, 58348), false);
  });

  test('is quiet when the page continues where we left off', () => {
    assert.equal(needsGapFill(58347, 58348), false);
    assert.equal(needsGapFill(58400, 58348), false, 'page older than the cursor');
  });

  test('fires when messages were missed', () => {
    assert.equal(needsGapFill(58000, 58348), true);
  });
});

describe('gapFillAdvanced', () => {
  test('continues while newer ids keep arriving', () => {
    assert.equal(gapFillAdvanced(58000, 58020), true);
  });

  // The termination condition is "no newer id", never id contiguity: deleted posts
  // leave permanent holes, so a contiguity check would loop forever.
  test('stops when a page yields nothing newer', () => {
    assert.equal(gapFillAdvanced(58020, 58020), false);
    assert.equal(gapFillAdvanced(58020, 58010), false);
    assert.equal(gapFillAdvanced(58020, null), false);
  });
});

describe('failureLogLevel', () => {
  test('escalates once, then stays quiet during a long outage', () => {
    assert.deepEqual([1, 2, 3, 4].map(failureLogLevel), ['warn', 'warn', 'warn', 'warn']);
    assert.equal(failureLogLevel(5), 'error');
    assert.equal(failureLogLevel(6), 'debug');
    assert.equal(failureLogLevel(20), 'error', 'a periodic reminder still gets through');
  });
});
