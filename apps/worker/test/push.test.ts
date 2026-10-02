import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { savePushSubscription, pushSubscriptionsOf } from '@horizont/db';
import { useTestDb } from './helpers.js';

const { PushSender, htmlToText } = await import('../src/notify/push.js');
const { fanout, notificationOf } = await import('../src/notify/delivery.js');

const getDb = useTestDb();
const VAPID = { publicKey: 'B'.repeat(87), privateKey: 'p'.repeat(43), subject: 'mailto:test@example.com' };

async function withSubs() {
  const db = getDb();
  await db.query(`INSERT INTO users (chat_id, is_active, created_at, updated_at) VALUES (100, 1, 0, 0)`);
  await savePushSubscription(db, 100, { endpoint: 'https://fcm.googleapis.com/a', p256dh: 'k1', auth: 'a1' }, 1);
  await savePushSubscription(db, 100, { endpoint: 'https://web.push.apple.com/b', p256dh: 'k2', auth: 'a2' }, 2);
  return db;
}

describe('PushSender', () => {
  test('sends the payload to every browser, short-lived and urgent', async () => {
    const db = await withSubs();
    const calls: { endpoint: string; payload: string; ttl: number | undefined; urgency: string | undefined }[] = [];
    const sender = new PushSender(db, VAPID, async (sub, payload, o) => {
      calls.push({ endpoint: sub.endpoint, payload, ttl: o.TTL, urgency: o.urgency });
      return { statusCode: 201 };
    });
    assert.equal(await sender.send(100, { title: 't', body: 'b', url: '/' }), 2);
    assert.equal(calls.length, 2);
    assert.deepEqual(JSON.parse(calls[0]!.payload), { title: 't', body: 'b', url: '/' });
    assert.equal(calls[0]!.ttl, 900);
    assert.equal(calls[0]!.urgency, 'high');
  });

  test('a subscription the push service calls gone is removed; a server error is not', async () => {
    const db = await withSubs();
    const sender = new PushSender(db, VAPID, async (sub) => {
      throw Object.assign(new Error('x'), { statusCode: sub.endpoint.includes('apple') ? 410 : 500 });
    });
    assert.equal(await sender.send(100, { title: 't', body: 'b', url: '/' }), 0);
    assert.deepEqual((await pushSubscriptionsOf(db, 100)).map((s) => s.endpoint), ['https://fcm.googleapis.com/a']);
  });
});

describe('fanout', () => {
  const pushStub = (n: number | Error) => ({ send: async () => { if (n instanceof Error) throw n; return n; } }) as never;
  const tg = (ok: boolean) => ({ sent: [] as string[], async sendMessage(_c: number, h: string) { if (!ok) throw new Error('403'); this.sent.push(h); } });

  test('either channel is enough; neither is an error to retry', async () => {
    await fanout(tg(true), pushStub(0))!.sendMessage(1, 'x');
    await fanout(tg(false), pushStub(1))!.sendMessage(1, 'x');
    await fanout(undefined, pushStub(2))!.sendMessage(1, 'x');
    await assert.rejects(fanout(tg(false), pushStub(0))!.sendMessage(1, 'x'));
    await assert.rejects(fanout(undefined, pushStub(new Error('down')))!.sendMessage(1, 'x'));
  });

  test('no channels means no sink; Telegram alone is passed through untouched', () => {
    assert.equal(fanout(undefined, undefined), undefined);
    const t = tg(true);
    assert.equal(fanout(t, undefined), t);
  });

  test('the notification is plain text: headline as title, every detail in the body', async () => {
    let got: { title: string; body: string } | undefined;
    const push = { send: async (_c: number, p: { title: string; body: string }) => { got = p; return 1; } } as never;
    await fanout(undefined, push)!.sendMessage(1, '⚠️ <b>БпЛА</b> — Баришівка (~58 км від вас) · пройде за ~9 км · ~19 хв (орієнтовно)');
    assert.deepEqual(got, {
      title: '⚠️ БпЛА',
      body: 'Баришівка (~58 км від вас) · пройде за ~9 км · ~19 хв (орієнтовно)\nДані з відкритих джерел, не є офіційним попередженням.',
      url: '/',
    } as never);
  });
});

describe('notificationOf', () => {
  test('several warnings: the count is in the title, every line in the body', () => {
    const n = notificationOf('⚠️ БпЛА — Бровари (~19 км від вас)\n⚠️ Реактивний БпЛА — курс на Бориспіль (~30 км від вас)');
    assert.equal(n.title, '⚠️ БпЛА +1');
    assert.match(n.body, /^Бровари .*\n⚠️ Реактивний БпЛА — курс на Бориспіль .*\nДані з відкритих джерел/);
  });
  test('an alert DM splits the same way', () => {
    assert.deepEqual(notificationOf('🚨 Повітряна тривога — Бучанський район'), {
      title: '🚨 Повітряна тривога',
      body: 'Бучанський район\nДані з відкритих джерел, не є офіційним попередженням.',
    });
  });
});

test('htmlToText strips tags and decodes what escapeHtml encodes', () => {
  assert.equal(htmlToText('<b>a</b> &lt;b&gt; &quot;c&quot; &#39;d&#39; &amp;amp;'), `a <b> "c" 'd' &amp;`);
});
