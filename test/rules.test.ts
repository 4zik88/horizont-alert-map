import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { Gazetteer } from '../src/parser/gazetteer.js';
import { parseMessage } from '../src/parser/index.js';
import { bearing, distanceKm } from '../src/parser/rules.js';
import { memoryDb, seedGazetteer } from './helpers.js';

const db = memoryDb();
seedGazetteer(db, [
  { name: 'Охтирка', oblast: 'sumska', place: 'town', population: 47000, lat: 50.3103, lon: 34.8986 },
  { name: 'Краснопілля', oblast: 'sumska', place: 'town', population: 7000, lat: 50.7667, lon: 35.2333 },
  { name: 'Богодухів', oblast: 'kharkivska', place: 'town', population: 16000, lat: 50.1667, lon: 35.5167 },
  { name: 'Путивль', oblast: 'sumska', place: 'town', population: 15000, lat: 51.3333, lon: 33.8667 },
  { name: 'Липова Долина', oblast: 'sumska', place: 'village', population: 3000, lat: 50.5667, lon: 33.8 },
  { name: 'Павлоград', oblast: 'dnipropetrovska', place: 'city', population: 105000, lat: 48.5350, lon: 35.8700 },
  { name: 'Ковель', oblast: 'volynska', place: 'city', population: 68000, lat: 51.2167, lon: 24.7167 },
  { name: 'Дніпро', oblast: 'dnipropetrovska', place: 'city', population: 968000, lat: 48.4647, lon: 35.0462 },
  { name: 'Нікополь', oblast: 'dnipropetrovska', place: 'city', population: 107000, lat: 47.5667, lon: 34.3833 },
  { name: 'Одеса', oblast: 'odeska', place: 'city', population: 1010000, lat: 46.4825, lon: 30.7233 },
  { name: 'Коростень', oblast: 'zhytomyrska', place: 'city', population: 60000, lat: 50.95, lon: 28.65 },
  { name: 'Котельва', oblast: 'poltavska', place: 'town', population: 11000, lat: 50.0667, lon: 34.75 },
  // A deliberate national collision, resolvable only by the oblast heading.
  { name: 'Михайлівка', oblast: 'sumska', place: 'village', population: 1200, lat: 50.9, lon: 34.2 },
  { name: 'Михайлівка', oblast: 'zaporizka', place: 'town', population: 8000, lat: 47.27, lon: 35.23 },
]);
const gaz = new Gazetteer(db);
const parse = (text: string) => parseMessage(text, gaz);

describe('parseMessage', () => {
  test('parses a multi-target message grouped by sticky oblast headings', () => {
    const { targets, state } = parse(
      'Сумщина:\nРеактивний БпЛА курсом на Краснопілля\nБпЛА курсом на Охтирку\n\nХарківщина:\nБпЛА курсом на Богодухів',
    );

    assert.equal(state, 'parsed');
    assert.equal(targets.length, 3);
    assert.deepEqual(
      targets.map((t) => [t.type, t.toName, t.oblast]),
      [
        ['jet_uav', 'Краснопілля', 'sumska'],
        ['uav', 'Охтирка', 'sumska'],
        ['uav', 'Богодухів', 'kharkivska'],
      ],
    );
  });

  test('resolves inflected destinations', () => {
    assert.equal(parse('БпЛА курсом на Охтирку').targets[0]?.toName, 'Охтирка');
    assert.equal(parse('БпЛА в напрямку Охтирки').targets[0]?.toName, 'Охтирка');
    assert.equal(parse('Реактивний над Павлоградом').targets[0]?.toName, 'Павлоград');
    assert.equal(parse('курс на Ковель').targets[0]?.toName, 'Ковель');
    assert.equal(parse('БпЛА курсом на Липову Долину').targets[0]?.toName, 'Липова Долина');
  });

  // One drone passing a waypoint on the way somewhere is a single target with a
  // course, not two targets.
  test('combines a waypoint and a destination into one target with a bearing', () => {
    const { targets } = parse('Сумщина - БпЛА повз Путивль, курсом на Охтирку');

    assert.equal(targets.length, 1);
    const target = targets[0]!;
    assert.equal(target.fromName, 'Путивль');
    assert.equal(target.toName, 'Охтирка');
    assert.equal(target.relation, 'towards');
    assert.ok(target.courseDeg !== null && target.courseDeg > 90 && target.courseDeg < 180,
      `expected a south-easterly course, got ${target.courseDeg}`);
  });

  test('uses the oblast heading to break a name collision', () => {
    assert.equal(parse('Сумщина:\nБпЛА курсом на Михайлівку').targets[0]?.oblast, 'sumska');
    assert.equal(parse('Запоріжжя:\nБпЛА курсом на Михайлівку').targets[0]?.oblast, 'zaporizka');
  });

  test('carries the count and the established type down bare lines', () => {
    const { targets } = parse('Сумщина:\n3 БпЛА курсом на Охтирку\n2х на Краснопілля');
    assert.equal(targets[0]?.count, 3);
    assert.equal(targets[1]?.count, 2);
    assert.equal(targets[1]?.type, 'uav', 'type carries over from the previous line');
  });

  test('accepts an oblast as a coarse destination', () => {
    const target = parse('КАБи на Дніпропетровщину').targets[0]!;
    assert.equal(target.type, 'kab');
    assert.equal(target.toName, 'Дніпропетровська');
    assert.ok(target.confidence < 0.8, 'an oblast-only destination must be low confidence');
  });

  // The product rule: never invent a marker. Unresolvable text goes to the feed.
  test('leaves unresolvable messages unparsed rather than guessing', () => {
    const result = parse('БпЛА курсом на Неіснуючесело');
    assert.equal(result.state, 'unparsed');
    assert.deepEqual(result.targets, []);
    assert.equal(result.needsLlm, true, 'it looks like a report, so Claude should see it');
  });

  test('ignores chatter that is not a report', () => {
    const result = parse('Всім доброго ранку, друзі!');
    assert.equal(result.state, 'unparsed');
    assert.equal(result.needsLlm, false, 'no point spending a Claude call on this');
  });

  test('strips the subscribe footer that would otherwise be a destination', () => {
    // "на Козака Чорнобая" appeared 469 times in the corpus and parses as a course.
    const { targets } = parse('Одещина реактивний на Охтирку\n\nПідписатися на Козака Чорнобая🔱');
    assert.equal(targets.length, 1);
    assert.equal(targets[0]?.toName, 'Охтирка');
  });
});

describe('real-world message shapes', () => {
  // "⚠ Дніпро" on its own line is a header; the next line refers back to it.
  test('resolves "над містом" against a header city line', () => {
    const { targets } = parse('⚠ Дніпро\n🏍 Реактивний БпЛА над містом! Перебувайте в укриттях!');
    assert.equal(targets.length, 1);
    assert.equal(targets[0]?.toName, 'Дніпро');
    assert.equal(targets[0]?.relation, 'over');
    assert.equal(targets[0]?.type, 'jet_uav');
  });

  test('a bare city header produces no target of its own', () => {
    assert.deepEqual(parse('⚠ Дніпро').targets, []);
  });

  test('understands "в р-ні" as a position, not a destination', () => {
    const { targets } = parse('Дніпропетровщина:\nРеактивні БпЛА в р-ні Павлограду');
    assert.equal(targets[0]?.toName, 'Павлоград');
    assert.equal(targets[0]?.relation, 'over');
  });

  test('takes the first resolvable option from slash alternatives', () => {
    const { targets } = parse('Групи ударних БпЛА у напрямку Одеси/Лиманки та Затоки.');
    assert.equal(targets[0]?.toName, 'Одеса');
  });

  test('combines a position with a stated compass course', () => {
    const { targets } = parse('Реактивний БпЛА північніше Нікополя північно-східним курсом');
    assert.equal(targets[0]?.toName, 'Нікополь');
    assert.equal(targets[0]?.courseDeg, 45);
  });

  // Regression: the oblast was being chosen as the destination over the settlement.
  test('prefers a settlement over an oblast named in the same line', () => {
    const { targets } = parse('Реактивний БпЛА на Житомирщині, змінив курс на Коростень.');
    assert.equal(targets[0]?.toName, 'Коростень', 'the oblast is context, not the destination');
    assert.equal(targets[0]?.oblast, 'zhytomyrska');
  });

  test('keeps the waypoint when the line only passes a town', () => {
    const { targets } = parse('Реактивний БпЛА на Полтавщині, повз Котельву курс південний.');
    assert.equal(targets[0]?.toName, 'Котельва');
    assert.equal(targets[0]?.relation, 'past');
    assert.equal(targets[0]?.courseDeg, 180);
  });
});

describe('geo helpers', () => {
  test('bearing points the right way', () => {
    assert.ok(Math.abs(bearing(50, 30, 51, 30) - 0) < 1, 'due north');
    assert.ok(Math.abs(bearing(50, 30, 50, 31) - 90) < 1, 'due east');
    assert.ok(Math.abs(bearing(50, 30, 49, 30) - 180) < 1, 'due south');
  });

  test('distance matches a known separation', () => {
    // Kyiv -> Kharkiv is about 410 km.
    const d = distanceKm(50.4501, 30.5234, 49.9935, 36.2304);
    assert.ok(d > 390 && d < 430, `got ${d}`);
  });
});
