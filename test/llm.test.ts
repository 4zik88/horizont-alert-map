import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { Gazetteer } from '../src/parser/gazetteer.js';
import { parseExtraction, toParsedTargets, type Extraction } from '../src/parser/llm.js';
import { memoryDb, seedGazetteer } from './helpers.js';

const db = memoryDb();
seedGazetteer(db, [
  { name: 'Охтирка', oblast: 'sumska', place: 'town', population: 47000, lat: 50.31, lon: 34.89 },
  { name: 'Путивль', oblast: 'sumska', place: 'town', population: 15000, lat: 51.33, lon: 33.87 },
  { name: 'Михайлівка', oblast: 'sumska', place: 'hamlet', population: 300, lat: 50.9, lon: 34.2 },
  { name: 'Михайлівка', oblast: 'zaporizka', place: 'town', population: 8000, lat: 47.27, lon: 35.23 },
]);
const gaz = new Gazetteer(db);

const target = (over: Partial<Extraction['targets'][number]> = {}) => ({
  type: 'uav' as const, count: 1, from: '', to: 'Охтирка', relation: 'towards' as const,
  oblast: '', time: '', confidence: 0.9, ...over,
});

describe('parseExtraction', () => {
  test('reads a clean JSON reply', () => {
    const out = parseExtraction('{"targets":[{"type":"uav","count":2,"from":"","to":"Охтирка","relation":"towards","oblast":"","time":"","confidence":0.8}]}');
    assert.equal(out?.targets.length, 1);
    assert.equal(out?.targets[0]?.count, 2);
  });

  // Small models wrap JSON in fences or chatter often enough to be worth recovering.
  test('recovers JSON from code fences and surrounding prose', () => {
    const body = '{"targets":[{"type":"uav","to":"Охтирка"}]}';
    for (const wrapped of [
      '```json\n' + body + '\n```',
      '```\n' + body + '\n```',
      'Here is the result:\n' + body + '\nHope that helps!',
    ]) {
      assert.equal(parseExtraction(wrapped)?.targets[0]?.to, 'Охтирка', wrapped.slice(0, 20));
    }
  });

  test('applies defaults for fields a model omits', () => {
    const out = parseExtraction('{"targets":[{"type":"uav","to":"Охтирка"}]}');
    assert.equal(out?.targets[0]?.count, 1);
    assert.equal(out?.targets[0]?.relation, 'towards');
    assert.equal(out?.targets[0]?.confidence, 0.5);
  });

  test('returns undefined for anything unusable', () => {
    for (const bad of [
      'I could not determine any targets.',
      '{"targets":[{"type":"spaceship","to":"Охтирка"}]}', // not in the enum
      '{"wrong":"shape"}',
      '{ broken json',
      '',
    ]) {
      assert.equal(parseExtraction(bad), undefined, bad.slice(0, 30));
    }
  });

  test('an empty target list is a valid answer', () => {
    assert.deepEqual(parseExtraction('{"targets":[]}')?.targets, []);
  });
});

describe('toParsedTargets', () => {
  test('grounds place names in the gazetteer', () => {
    const out = toParsedTargets({ targets: [target()] }, 'src', gaz, 1000);
    assert.equal(out[0]?.toName, 'Охтирка');
    assert.equal(out[0]?.toLat, 50.31);
  });

  // The central guard: a hallucinated place yields nothing rather than a wrong pin.
  test('drops targets whose destination is not a real place', () => {
    const out = toParsedTargets({ targets: [target({ to: 'Ельдорадо' })] }, 'src', gaz, 1000);
    assert.deepEqual(out, []);
  });

  test('uses the reported oblast to disambiguate a shared name', () => {
    const sumy = toParsedTargets({ targets: [target({ to: 'Михайлівка', oblast: 'Сумщина' })] }, 's', gaz, 1000);
    const zap = toParsedTargets({ targets: [target({ to: 'Михайлівка', oblast: 'Запоріжжя' })] }, 's', gaz, 1000);
    assert.equal(sumy[0]?.oblast, 'sumska');
    assert.equal(zap[0]?.oblast, 'zaporizka');
  });

  test('computes a course when both ends are known', () => {
    const out = toParsedTargets({ targets: [target({ from: 'Путивль', to: 'Охтирка' })] }, 's', gaz, 1000);
    assert.equal(out[0]?.fromName, 'Путивль');
    assert.ok(out[0]?.courseDeg !== null);
  });

  test('multiplies model confidence by gazetteer confidence', () => {
    // Ambiguous name, no oblast given -> the result must not look certain.
    const out = toParsedTargets({ targets: [target({ to: 'Михайлівка', confidence: 1 })] }, 's', gaz, 1000);
    assert.ok((out[0]?.confidence ?? 1) < 1);
  });
});
