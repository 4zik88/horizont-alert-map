import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { Repo } from '../src/db/repo.js';
import { ParseWorker, PARSER_VERSION } from '../src/parser/worker.js';
import { DISABLED_EXTRACTOR, resolveObservedAt, type LlmExtractor } from '../src/parser/llm.js';
import type { ParsedTarget } from '../src/parser/rules.js';
import { memoryDb, seedGazetteer } from './helpers.js';

function setup(llm: LlmExtractor = DISABLED_EXTRACTOR) {
  const db = memoryDb();
  seedGazetteer(db, [
    { name: 'Охтирка', oblast: 'sumska', place: 'town', population: 47000, lat: 50.31, lon: 34.89 },
    { name: 'Ніжин', oblast: 'chernihivska', place: 'city', population: 70000, lat: 51.05, lon: 31.88 },
  ]);
  const repo = new Repo(db);
  const worker = new ParseWorker(db, repo, llm, {
    batchSize: 50,
    intervalMs: 60_000,
    llmBudgetPerBatch: 10,
  });
  return { db, repo, worker };
}

let nextId = 1;
function addMessage(
  db: ReturnType<typeof memoryDb>,
  text: string,
  opts: { sensitive?: boolean } = {},
): number {
  const id = nextId++;
  db.prepare(`
    INSERT INTO messages (channel, message_id, posted_at, fetched_at, text, content_hash, is_sensitive)
    VALUES ('t', ?, 1000, 1000, ?, ?, ?)
  `).run(id, text, `h${id}`, opts.sensitive ? 1 : 0);
  return id;
}

const targetsFor = (db: ReturnType<typeof memoryDb>) =>
  db.prepare('SELECT * FROM targets ORDER BY message_id, seq').all() as Record<string, never>[];
const stateOf = (db: ReturnType<typeof memoryDb>, messageId: number) =>
  (db.prepare('SELECT parse_state FROM messages WHERE message_id = ?').get(messageId) as { parse_state: string }).parse_state;

describe('ParseWorker', () => {
  test('parses pending messages into targets', async () => {
    const { db, worker } = setup();
    addMessage(db, 'Сумщина:\nБпЛА курсом на Охтирку');

    const result = await worker.runBatch();

    assert.equal(result.parsed, 1);
    const rows = targetsFor(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!['to_name'], 'Охтирка');
    assert.equal(rows[0]!['source'], 'rules');
    assert.equal(rows[0]!['observed_at'], 1000, 'targets carry the message timestamp');
  });

  test('never parses sensitive messages into targets', async () => {
    const { db, worker } = setup();
    const id = addMessage(db, 'Збито 10 БпЛА, зафіксовано влучання на Охтирку', { sensitive: true });

    await worker.runBatch();

    assert.equal(targetsFor(db).length, 0, 'impact reports must never become map targets');
    assert.equal(stateOf(db, id), 'skipped');
  });

  test('marks unresolvable text unparsed with no targets', async () => {
    const { db, worker } = setup();
    const id = addMessage(db, 'Доброго вечора, ми з України');

    await worker.runBatch();

    assert.equal(targetsFor(db).length, 0);
    assert.equal(stateOf(db, id), 'unparsed', 'it goes to the feed as plain text');
  });

  test('is idempotent — re-parsing replaces targets instead of duplicating', async () => {
    const { db, repo, worker } = setup();
    addMessage(db, 'Сумщина:\nБпЛА курсом на Охтирку');
    await worker.runBatch();
    assert.equal(targetsFor(db).length, 1);

    // An edit requeues the message; step 1's ingest does exactly this.
    db.prepare(`UPDATE messages SET parse_state='pending', text='БпЛА курсом на Ніжин'`).run();
    await worker.runBatch();

    const rows = targetsFor(db);
    assert.equal(rows.length, 1, 'the old target must be gone, not accumulated');
    assert.equal(rows[0]!['to_name'], 'Ніжин');
    void repo;
  });

  test('records the parser version so the archive can be requeued later', async () => {
    const { db, worker } = setup();
    const id = addMessage(db, 'БпЛА курсом на Охтирку');
    await worker.runBatch();
    const row = db.prepare('SELECT parser_version FROM messages WHERE message_id = ?').get(id) as { parser_version: number };
    assert.equal(row.parser_version, PARSER_VERSION);
  });

  test('falls back to Claude only when the rules find nothing, and respects the budget', async () => {
    let calls = 0;
    const stub: LlmExtractor = {
      async extract(): Promise<ParsedTarget[]> {
        calls++;
        return [{
          type: 'uav', rawType: null, count: 1, oblast: 'sumska', relation: 'towards',
          toName: 'Охтирка', toLat: 50.31, toLon: 34.89,
          fromName: null, fromLat: null, fromLon: null,
          courseDeg: null, confidence: 0.8, sourceLine: 'llm',
        }];
      },
    };
    const { db, worker } = setup(stub);

    addMessage(db, 'Сумщина:\nБпЛА курсом на Охтирку');       // rules succeed
    // Mentions a target but names no place after any cue the rules know, so they find
    // nothing while it still clearly reads as a report — exactly the LLM's job.
    addMessage(db, 'Повідомляють про бпла, точне місце поки невідоме');
    addMessage(db, 'Всім гарного дня');                        // not a report at all

    const result = await worker.runBatch();

    assert.equal(calls, 1, 'Claude is called only for the message the rules could not resolve');
    assert.equal(result.llmCalls, 1);
    const llmRows = targetsFor(db).filter((r) => r['source'] === 'llm');
    assert.equal(llmRows.length, 1);
  });

  test('a failing Claude call never breaks the batch', async () => {
    const throwing: LlmExtractor = {
      async extract(): Promise<ParsedTarget[]> {
        throw new Error('network down');
      },
    };
    const { db, worker } = setup(throwing);
    addMessage(db, 'БпЛА курсом на Охтирку');
    addMessage(db, 'незрозумілий текст про бпла кудись');

    // Must not reject: ingestion continues even when enrichment fails.
    const result = await worker.runBatch();
    assert.equal(result.parsed, 1);
  });
});

describe('resolveObservedAt', () => {
  const posted = Date.UTC(2026, 8, 13, 17, 40, 0);

  test('uses a stated time when it is close to the post', () => {
    assert.equal(resolveObservedAt('17:20', posted), Date.UTC(2026, 8, 13, 17, 20, 0));
    assert.equal(resolveObservedAt('18.05', posted), Date.UTC(2026, 8, 13, 18, 5, 0));
  });

  test('crosses midnight to the nearest plausible instant', () => {
    const justAfterMidnight = Date.UTC(2026, 8, 14, 0, 30, 0);
    // "23:50" posted at 00:30 means the previous day, not 23 hours in the future.
    assert.equal(resolveObservedAt('23:50', justAfterMidnight), Date.UTC(2026, 8, 13, 23, 50, 0));
  });

  // A hallucinated or misread time must not drop a target hours away in the
  // timeline, where it would never notify or would fade off the map instantly.
  test('rejects implausible and malformed times', () => {
    assert.equal(resolveObservedAt('03:00', posted), posted, 'too far from the post');
    assert.equal(resolveObservedAt('99:99', posted), posted);
    assert.equal(resolveObservedAt('', posted), posted);
    assert.equal(resolveObservedAt(undefined, posted), posted);
    assert.equal(resolveObservedAt('скоро', posted), posted);
  });
});
