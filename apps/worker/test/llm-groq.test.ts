import assert from 'node:assert/strict';
import { test, describe, afterEach } from 'node:test';
import { loadGazetteer } from '../src/db/gazetteer.js';
import { memoryDb, seedGazetteer } from './helpers.js';

// config reads process.env once at import, so the key must be set before loading it.
process.env['GROQ_API_KEY'] = 'test-key';
process.env['GROQ_MODEL'] = 'test-model';
const { createGroqExtractor } = await import('../src/parser/llm-groq.js');

const db = memoryDb();
seedGazetteer(db, [
  { name: 'Охтирка', oblast: 'sumska', place: 'town', population: 47000, lat: 50.31, lon: 34.89 },
]);
const extractor = createGroqExtractor(loadGazetteer(db));

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stub(status: number, body: unknown, headers: Record<string, string> = {}) {
  globalThis.fetch = (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    })) as typeof fetch;
}

const reply = (content: string) => ({ choices: [{ message: { content } }] });
const GOOD = '{"targets":[{"type":"uav","count":1,"from":"","to":"Охтирка","relation":"towards","oblast":"Сумщина","time":"","confidence":0.9}]}';

describe('Groq extractor', () => {
  test('extracts targets from a well-formed reply', async () => {
    stub(200, reply(GOOD));
    const out = await extractor.extract('БпЛА кудись летить', 1000);
    assert.equal(out?.length, 1);
    assert.equal(out?.[0]?.toName, 'Охтирка');
    assert.equal(out?.[0]?.oblast, 'sumska');
  });

  test('sends the model, zero temperature and both messages', async () => {
    let sent: any;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string);
      return new Response(JSON.stringify(reply(GOOD)), { status: 200 });
    }) as unknown as typeof fetch;

    await extractor.extract('текст', 1000);
    assert.equal(sent.model, 'test-model');
    assert.equal(sent.temperature, 0, 'extraction must be deterministic');
    assert.equal(sent.messages[0].role, 'system');
    assert.equal(sent.messages[1].content, 'текст');
  });

  // Every failure below must degrade to "no answer" (null), never throw: the message
  // keeps whatever the rules found, and nothing is cached as if the model had replied.
  test('survives rate limiting', async () => {
    stub(429, { error: { message: 'rate limit' } }, { 'retry-after': '30' });
    assert.equal(await extractor.extract('текст', 1000), null);
  });

  test('survives a decommissioned model name', async () => {
    stub(404, { error: { message: 'model `x` does not exist' } });
    assert.equal(await extractor.extract('текст', 1000), null);
  });

  test('survives prose instead of JSON', async () => {
    stub(200, reply('I am sorry, I cannot determine any targets from this message.'));
    assert.equal(await extractor.extract('текст', 1000), null);
  });

  test('survives an empty or malformed envelope', async () => {
    stub(200, { choices: [] });
    assert.equal(await extractor.extract('текст', 1000), null);
    stub(200, 'not json at all');
    assert.equal(await extractor.extract('текст', 1000), null);
  });

  test('survives a network failure', async () => {
    globalThis.fetch = (async () => { throw new Error('ECONNRESET'); }) as typeof fetch;
    assert.equal(await extractor.extract('текст', 1000), null);
  });

  test('recovers JSON wrapped in a code fence', async () => {
    stub(200, reply('```json\n' + GOOD + '\n```'));
    const out = await extractor.extract('текст', 1000);
    assert.equal(out?.[0]?.toName, 'Охтирка');
  });

  test('drops a hallucinated place rather than inventing a pin', async () => {
    stub(200, reply('{"targets":[{"type":"uav","count":1,"from":"","to":"Атлантида","relation":"towards","oblast":"","time":"","confidence":0.99}]}'));
    assert.deepEqual(await extractor.extract('текст', 1000), []);
  });
});
