import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { Repo } from '../src/db/repo.js';
import { ParseWorker, PARSER_VERSION } from '../src/parser/worker.js';
import { DISABLED_EXTRACTOR, resolveObservedAt, type LlmExtractor } from '../src/parser/llm.js';
import type { ParsedTarget } from '@horizont/parser';
import type { Db } from '../src/db/index.js';
import { scalar, seedGazetteer, useTestDb } from './helpers.js';
import { loadGazetteer } from '../src/db/gazetteer.js';

const getDb = useTestDb();

async function setup(llm: LlmExtractor = DISABLED_EXTRACTOR) {
  const db = getDb();
  await seedGazetteer(db, [
    { name: 'Охтирка', oblast: 'sumska', place: 'town', population: 47000, lat: 50.31, lon: 34.89 },
    { name: 'Ніжин', oblast: 'chernihivska', place: 'city', population: 70000, lat: 51.05, lon: 31.88 },
  ]);
  const repo = new Repo(db);
  const worker = new ParseWorker(await loadGazetteer(db), repo, llm, {
    batchSize: 50,
    intervalMs: 60_000,
    llmBudgetPerBatch: 10,
  });
  return { db, repo, worker };
}

let nextId = 1;
async function addMessage(
  db: Db,
  text: string,
  opts: { sensitive?: boolean; hash?: string; postedAt?: number } = {},
): Promise<number> {
  const id = nextId++;
  const posted = opts.postedAt ?? 1000;
  await db.query(`
    INSERT INTO messages (channel, message_id, posted_at, fetched_at, text, content_hash, is_sensitive)
    VALUES ('t', $1, $2, $3, $4, $5, $6)
  `, [id, posted, posted, text, opts.hash ?? `h${id}`, opts.sensitive ? 1 : 0]);
  return id;
}

const targetsFor = async (db: Db) =>
  (await db.query<Record<string, never>>('SELECT * FROM targets ORDER BY message_id, seq')).rows;
const stateOf = async (db: Db, messageId: number) =>
  scalar<string>(db, 'SELECT parse_state FROM messages WHERE message_id = $1', [messageId]);

describe('ParseWorker', () => {
  test('parses pending messages into targets', async () => {
    const { db, worker } = await setup();
    await addMessage(db, 'Сумщина:\nБпЛА курсом на Охтирку');

    const result = await worker.runBatch();

    assert.equal(result.parsed, 1);
    const rows = await targetsFor(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!['to_name'], 'Охтирка');
    assert.equal(rows[0]!['source'], 'rules');
    assert.equal(rows[0]!['observed_at'], 1000, 'targets carry the message timestamp');
  });

  test('never parses sensitive messages into targets', async () => {
    const { db, worker } = await setup();
    const id = await addMessage(db, 'Збито 10 БпЛА, зафіксовано влучання на Охтирку', { sensitive: true });

    await worker.runBatch();

    assert.equal((await targetsFor(db)).length, 0, 'impact reports must never become map targets');
    assert.equal(await stateOf(db, id), 'skipped');
  });

  test('marks unresolvable text unparsed with no targets', async () => {
    const { db, worker } = await setup();
    const id = await addMessage(db, 'Доброго вечора, ми з України');

    await worker.runBatch();

    assert.equal((await targetsFor(db)).length, 0);
    assert.equal(await stateOf(db, id), 'unparsed', 'it goes to the feed as plain text');
  });

  test('is idempotent — re-parsing replaces targets instead of duplicating', async () => {
    const { db, repo, worker } = await setup();
    await addMessage(db, 'Сумщина:\nБпЛА курсом на Охтирку');
    await worker.runBatch();
    assert.equal((await targetsFor(db)).length, 1);

    // An edit requeues the message; step 1's ingest does exactly this.
    await db.query(`UPDATE messages SET parse_state='pending', text='БпЛА курсом на Ніжин'`);
    await worker.runBatch();

    const rows = await targetsFor(db);
    assert.equal(rows.length, 1, 'the old target must be gone, not accumulated');
    assert.equal(rows[0]!['to_name'], 'Ніжин');
    void repo;
  });

  test('records the parser version so the archive can be requeued later', async () => {
    const { db, worker } = await setup();
    const id = await addMessage(db, 'БпЛА курсом на Охтирку');
    await worker.runBatch();
    assert.equal(
      await scalar(db, 'SELECT parser_version FROM messages WHERE message_id = $1', [id]),
      PARSER_VERSION,
    );
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
    const { db, worker } = await setup(stub);

    await addMessage(db, 'Сумщина:\nБпЛА курсом на Охтирку');       // rules succeed
    // Mentions a target but names no place after any cue the rules know, so they find
    // nothing while it still clearly reads as a report — exactly the LLM's job.
    await addMessage(db, 'Повідомляють про бпла, точне місце поки невідоме');
    await addMessage(db, 'Всім гарного дня');                        // not a report at all

    const result = await worker.runBatch();

    assert.equal(calls, 1, 'Claude is called only for the message the rules could not resolve');
    assert.equal(result.llmCalls, 1);
    const llmRows = (await targetsFor(db)).filter((r) => r['source'] === 'llm');
    assert.equal(llmRows.length, 1);
  });

  test('a failing Claude call never breaks the batch', async () => {
    const throwing: LlmExtractor = {
      async extract(): Promise<ParsedTarget[]> {
        throw new Error('network down');
      },
    };
    const { db, worker } = await setup(throwing);
    await addMessage(db, 'БпЛА курсом на Охтирку');
    await addMessage(db, 'незрозумілий текст про бпла кудись');

    // Must not reject: ingestion continues even when enrichment fails.
    const result = await worker.runBatch();
    assert.equal(result.parsed, 1);
  });
});

/*
 * Map publishing hooks onto saveTargets: it must hand back the ids it created, in the
 * order the parser produced the targets, and a re-parse must replace rather than add.
 */
describe('Repo.saveTargets', () => {
  const target = (toName: string, observedAt: number) => ({
    messageId: 0, type: 'uav', rawType: null, count: 1, oblast: 'sumska', relation: 'towards',
    fromName: null, fromLat: null, fromLon: null, toName, toLat: 50.31, toLon: 34.89,
    courseDeg: null, confidence: 0.9, source: 'rules', observedAt, createdAt: observedAt,
  });

  test('returns the new target ids in seq order and replaces on re-save', async () => {
    const { db, repo } = await setup();
    const messageId = await addMessage(db, 'x');
    const id = await scalar(db, 'SELECT id FROM messages WHERE message_id = $1', [messageId]);
    const rows = ['Охтирка', 'Ніжин', 'Суми'].map((n, i) => ({ ...target(n, 1000 + i), messageId: id }));

    const first = await repo.saveTargets(id, rows, 'parsed', 2000, PARSER_VERSION);
    const stored = (await db.query<{ id: number; seq: number; to_name: string }>(
      'SELECT id, seq, to_name FROM targets ORDER BY seq',
    )).rows;
    assert.deepEqual(first, stored.map((r) => r.id));
    assert.deepEqual(stored.map((r) => r.to_name), ['Охтирка', 'Ніжин', 'Суми']);

    const second = await repo.saveTargets(id, rows.slice(0, 2), 'parsed', 3000, PARSER_VERSION);
    assert.equal(second.length, 2);
    assert.ok(second.every((n) => !first.includes(n)), 'a re-save creates new rows');
    assert.deepEqual(
      (await db.query<{ id: number }>('SELECT id FROM targets ORDER BY seq')).rows.map((r) => r.id),
      second,
    );
    assert.equal(await stateOf(db, messageId), 'parsed');
  });

  test('an empty save clears the targets and returns no ids', async () => {
    const { db, repo } = await setup();
    const messageId = await addMessage(db, 'x');
    const id = await scalar(db, 'SELECT id FROM messages WHERE message_id = $1', [messageId]);
    await repo.saveTargets(id, [{ ...target('Охтирка', 1000), messageId: id }], 'parsed', 2000, 1);

    assert.deepEqual(await repo.saveTargets(id, [], 'unparsed', 3000, 1), []);
    assert.equal((await targetsFor(db)).length, 0);
    assert.equal(await stateOf(db, messageId), 'unparsed');
  });

  test('a failure rolls the whole replacement back', async () => {
    const { db, repo } = await setup();
    const messageId = await addMessage(db, 'x');
    const id = await scalar(db, 'SELECT id FROM messages WHERE message_id = $1', [messageId]);
    await repo.saveTargets(id, [{ ...target('Охтирка', 1000), messageId: id }], 'parsed', 2000, 1);

    // The second row violates NOT NULL on `type`, after the delete and the first insert.
    const bad = [{ ...target('Ніжин', 1000), messageId: id }, { ...target('Суми', 1000), messageId: id, type: null as unknown as string }];
    await assert.rejects(repo.saveTargets(id, bad, 'parsed', 3000, 2));

    const rows = await targetsFor(db);
    assert.deepEqual(rows.map((r) => r['to_name']), ['Охтирка'], 'the old targets are still there');
    assert.equal(await scalar(db, 'SELECT parser_version FROM messages WHERE id = $1', [id]), 1);
  });
});

describe('resolveObservedAt', () => {
  // 17:40 UTC on 13 September is 20:40 in Kyiv (summer time, UTC+3).
  const posted = Date.UTC(2026, 8, 13, 17, 40, 0);

  test('reads a stated time as Kyiv wall-clock time', () => {
    assert.equal(resolveObservedAt('20:20', posted), Date.UTC(2026, 8, 13, 17, 20, 0));
    assert.equal(resolveObservedAt('21.05', posted), Date.UTC(2026, 8, 13, 18, 5, 0));
  });

  test('crosses midnight to the nearest plausible instant', () => {
    // 00:30 Kyiv on the 14th; "23:50" means the 13th, not 23 hours ahead.
    const justAfterMidnight = Date.UTC(2026, 8, 13, 21, 30, 0);
    assert.equal(resolveObservedAt('23:50', justAfterMidnight), Date.UTC(2026, 8, 13, 20, 50, 0));
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

describe('LLM budget and cache', () => {
  // Rules cannot place "Атлантида", but the line names a type and a capitalised word,
  // so it is handed to the model.
  const UNRESOLVED = 'БпЛА кружляє біля Атлантиди';

  function countingLlm(answer: () => ParsedTarget[] | null) {
    let calls = 0;
    const llm: LlmExtractor = {
      name: 'fake',
      async extract(_text: string, postedAt: number) {
        calls++;
        const out = answer();
        return out && out.map((t) => ({ ...t, observedAt: postedAt - 60_000 }));
      },
    };
    return { llm, calls: () => calls };
  }

  const okhtyrka = (): ParsedTarget[] => [{
    type: 'uav', rawType: null, count: 1, oblast: 'sumska', relation: 'over',
    toName: 'Охтирка', toLat: 50.31, toLon: 34.89, fromName: null, fromLat: null, fromLon: null,
    courseDeg: null, confidence: 0.7, sourceLine: UNRESOLVED,
  }];

  test('the same text never pays twice, and the cached time follows the new post', async () => {
    const fake = countingLlm(okhtyrka);
    const { db, worker } = await setup(fake.llm);
    await addMessage(db, UNRESOLVED, { hash: 'same', postedAt: 10_000_000 });
    await worker.runBatch();
    await addMessage(db, UNRESOLVED, { hash: 'same', postedAt: 20_000_000 });
    await worker.runBatch();

    assert.equal(fake.calls(), 1);
    const rows = await targetsFor(db);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r['observed_at']), [10_000_000 - 60_000, 20_000_000 - 60_000]);
    assert.ok(rows.every((r) => r['source'] === 'llm'));
  });

  test('an edited message does not buy a second call', async () => {
    const fake = countingLlm(okhtyrka);
    const { db, worker } = await setup(fake.llm);
    const id = await addMessage(db, UNRESOLVED, { hash: 'v1' });
    await worker.runBatch();

    await db.query(
      `UPDATE messages SET text = $1, content_hash = 'v2', parse_state = 'pending' WHERE message_id = $2`,
      [UNRESOLVED + ' знову', id],
    );
    await worker.runBatch();

    assert.equal(fake.calls(), 1);
  });

  test('a failed call is neither cached nor counted as the message\'s call', async () => {
    let fail = true;
    const fake = countingLlm(() => (fail ? null : okhtyrka()));
    const { db, worker } = await setup(fake.llm);
    const id = await addMessage(db, UNRESOLVED, { hash: 'x' });
    await worker.runBatch();

    assert.equal(await scalar(db, 'SELECT COUNT(*) AS n FROM llm_cache'), 0);
    assert.equal(
      await scalar<number | null>(db, 'SELECT llm_called_at FROM messages WHERE message_id = $1', [id]),
      null,
    );

    fail = false;
    await db.query(`UPDATE messages SET parse_state = 'pending' WHERE message_id = $1`, [id]);
    await worker.runBatch();
    assert.equal(fake.calls(), 2);
    assert.equal((await targetsFor(db)).length, 1);
  });

  test('an empty answer is an answer, and is cached', async () => {
    const fake = countingLlm(() => []);
    const { db, worker } = await setup(fake.llm);
    await addMessage(db, UNRESOLVED, { hash: 'empty' });
    await addMessage(db, UNRESOLVED, { hash: 'empty' });
    await worker.runBatch();

    assert.equal(fake.calls(), 1);
  });
});
