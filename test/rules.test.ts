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
  // A launch site, for the launch-report cases below.
  { name: 'Гвардійське', oblast: 'krym', place: 'town', population: 12000, lat: 45.12, lon: 34.02 },
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

describe('launch reports', () => {
  /*
   * The place in a launch report is where the weapons came from. Drawing a marker on
   * it says a target is somewhere it is not — the failure that put a drone icon over
   * Vinnytsia for a launch reported from Crimea.
   */
  test('records the launch site as an origin, with no position to draw', () => {
    const { targets } = parse('Пуски шахедів з Гвардійського.');
    assert.equal(targets.length, 1);
    assert.equal(targets[0]!.relation, 'launch');
    assert.equal(targets[0]!.toLat, null);
    assert.equal(targets[0]!.toName, null);
    assert.ok(targets[0]!.fromLat !== null, 'the origin should still be known');
  });

  test('does not invent a course for a launch', () => {
    const { targets } = parse('пуски шахедів з Гвардійського');
    assert.equal(targets[0]!.courseDeg, null);
  });

  /*
   * A movement *from* the sea *to* a region is not a launch report: the destination
   * is stated and must survive.
   */
  test('keeps a destination when the line states one', () => {
    const { targets } = parse('Група БпЛА з акваторії Чорного моря - на південь Одещини.');
    assert.equal(targets.length, 1);
    assert.equal(targets[0]!.fromName, 'Чорне море');
    assert.ok(targets[0]!.toLat !== null, 'the destination should still be drawn');
  });
});

describe('"курс" without a preposition', () => {
  /*
   * "курс Крижопіль" drops the "на" that the cue used to require, so the destination
   * was never seen: the target sat on the oblast centre with no heading at all, which
   * is what a reader notices as "the arrow points the wrong way".
   */
  test('reads a bare "курс <place>" as the destination', () => {
    const { targets } = parse('Реактивний БпЛА на Сумщині, курс Охтирка');
    assert.equal(targets.length, 1);
    assert.equal(targets[0]!.toName, 'Охтирка');
    assert.ok(targets[0]!.courseDeg !== null, 'a bearing should follow from the pair');
  });

  /*
   * The same cue must not swallow a compass course. It cannot, because the place
   * pattern is case-sensitive and the compass word is lowercase — this pins that.
   */
  test('still reads "курс західний" as a heading, not a place', () => {
    const { targets } = parse('Ударні БпЛА на півдні Сумщини, курс західний.');
    assert.equal(targets[0]!.courseDeg, 270);
  });
});

describe('messages that are not target reports', () => {
  /*
   * These put markers on central Odesa. A wrong pin is worse than no pin — the text
   * still reaches the feed either way, which is the specified behaviour.
   */
  test('a railway bulletin naming a city is not a target', () => {
    const { targets } = parse(
      'На Одещині та в напрямку Одеси значні затримки поїздів через ворожу атаку яка триває',
    );
    assert.deepEqual(targets, []);
  });

  test('a warning about future strikes is not a target', () => {
    const { targets } = parse('ворог готує нові удари по АЗС та ТРЦ у Києві');
    assert.deepEqual(targets, []);
  });

  /*
   * The shorthand must survive: @sectorv666 tracks a wave one line per drone with the
   * type stated once and then dropped, and those lines are nothing but a cue and a
   * place. Length is what separates them from the bulletins above.
   */
  test('keeps the one-line-per-drone shorthand', () => {
    assert.equal(parse('На Охтирку').targets.length, 1);
    assert.equal(parse('Цей на Охтирку').targets.length, 1);
  });
});

describe('a transit is not a launch', () => {
  /*
   * "шахед залітає з Одещини" is a drone passing through, not a launch. Drawing it as
   * one claimed a launch from Ukrainian-held Odesa.
   */
  test('an origin without a launch word is not marked as a launch', () => {
    const { targets } = parse('шахед залітає з Сумщини');
    assert.equal(targets.length, 1);
    assert.equal(targets[0]!.relation, 'from');
  });

  test('a stated launch is', () => {
    const { targets } = parse('Пуски шахедів з Гвардійського');
    assert.equal(targets[0]!.relation, 'launch');
  });
});

describe('enemy launch sites', () => {
  /*
   * These sit outside Ukraine, so the gazetteer has none of them and the launch was
   * dropped entirely — while they are where most of a night's Shaheds come from.
   */
  test('resolves sites the gazetteer cannot know', () => {
    const { targets } = parse('+ повторні пуски шахедів з району Курська, Брянську та Орла.');
    assert.deepEqual(targets.map((t) => t.fromName), ['Курськ', 'Брянськ', 'Орел']);
    assert.ok(targets.every((t) => t.relation === 'launch' && t.toLat === null));
  });

  test('one launch per site named, not just the first', () => {
    const { targets } = parse('пуски шахедів: 3 з Смоленська, 10 з Курська, 10 з Орла');
    assert.equal(targets.length, 3);
  });

  /*
   * "з району Навля (Брянська область)" is one site with its region in brackets, and
   * counting the bracket separately doubled every launch this channel reported.
   */
  test('a bracketed region does not become a second launch', () => {
    const { targets } = parse('Пуск Shahed-136 з району Навля (Брянська область).');
    assert.deepEqual(targets.map((t) => t.fromName), ['Навля']);
  });

  /*
   * Outside a launch report these names are ordinary context. A drone over Chernihiv
   * oblast that came from Bryansk is not a marker in Russia.
   */
  test('only a launch report resolves them', () => {
    const { targets } = parse('Реактивний БпЛА курсом на Охтирку з Брянської області');
    assert.ok(targets.every((t) => t.fromName !== 'Брянськ'));
  });

  /*
   * `курс` is among the commonest words in these channels; a prefix rule on `курськ`
   * would turn every stated course into a launch from Kursk.
   */
  test('a stated course is not a launch from Kursk', () => {
    const { targets } = parse('Ударні БпЛА на півдні Сумщини, курс західний.');
    assert.equal(targets[0]!.relation, 'over');
    assert.equal(targets[0]!.courseDeg, 270);
  });
});

describe('oblast heading without punctuation', () => {
  /*
   * Half these channels drop the colon, and the oblast is the only thing that
   * disambiguates a name. Six villages are called Красне; without the context the
   * ranking picks the largest and an Odesa-oblast target landed 500 km away in Lviv
   * oblast.
   */
  test('a bare oblast prefix still sets the context', () => {
    const { targets } = parse('Сумщина реактивний на Михайлівку');
    assert.equal(targets.length, 1);
    assert.equal(targets[0]!.oblast, 'sumska');
    // The Sumy Mykhailivka, not the Zaporizhzhia one of the same name.
    assert.equal(targets[0]!.toLat, 50.9);
  });

  test('the colon form still works', () => {
    const { targets } = parse('Сумщина: реактивний на Михайлівку');
    assert.equal(targets[0]!.toLat, 50.9);
  });

  /*
   * A line naming a weapon is a report, not a header. This only surfaced once the
   * prefix was stripped: "Одещина Дачне шахед" used to resolve to the oblast first,
   * which is not a settlement, so it fell through by luck.
   */
  test('"<place> <weapon>" is a target, not a city header', () => {
    const { targets } = parse('Сумщина Охтирка шахед');
    assert.equal(targets.length, 1);
    assert.equal(targets[0]!.toName, 'Охтирка');
  });

  /*
   * And a header has to be only the name — "Волинь Луцьк уважно" is a warning about
   * Lutsk, and swallowing it dropped the one place the writer wanted looked at.
   */
  test('a place with anything after it is not a header', () => {
    const { targets } = parse('БпЛА\nСумщина Охтирка уважно');
    assert.ok(targets.some((t) => t.toName === 'Охтирка'));
  });
});
