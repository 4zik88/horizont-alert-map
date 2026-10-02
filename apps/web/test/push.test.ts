import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keyBytes, pushAvailability, type PushEnvironment } from '../src/push.js';

const env = (o: Partial<PushEnvironment> = {}): PushEnvironment => ({
  serverKey: 'BKey', supported: true, ios: false, standalone: false, permission: 'default', ...o,
});

test('no server key: the toggle is not shown at all', () => {
  assert.deepEqual(pushAvailability(env({ serverKey: null })), { show: false });
});

test('iPhone outside the installed app: shown, with how to install', () => {
  const a = pushAvailability(env({ ios: true, standalone: false }));
  assert.equal(a.show && !a.usable && /На початковий екран/.test(a.hint), true);
  assert.deepEqual(pushAvailability(env({ ios: true, standalone: true })), { show: true, usable: true });
});

test('unsupported or denied: shown, with the reason', () => {
  const u = pushAvailability(env({ supported: false }));
  assert.equal(u.show && !u.usable, true);
  const d = pushAvailability(env({ permission: 'denied' }));
  assert.equal(d.show && !d.usable && /заборонені/.test(d.hint), true);
});

test('keyBytes decodes base64url, padding or not', () => {
  assert.deepEqual([...keyBytes('AQID')], [1, 2, 3]);
  assert.deepEqual([...keyBytes('_-8')], [255, 239]);
});
