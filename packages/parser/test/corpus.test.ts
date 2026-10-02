import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { geoDataPath } from '@horizont/geo/node';
import { Gazetteer } from '../src/gazetteer.js';
import { isSensitive } from '../src/sensitive.js';
import { parseMessage } from '../src/message.js';
import type { ParsedTarget } from '../src/rules.js';

/*
 * Real messages from @kpszsu, @KozakChornobay and @sectorv666, verbatim from the
 * stored corpus (September 2026), parsed against the gazetteer a fresh deploy ships
 * with. Every expectation was checked by reading the message, not by recording what
 * the parser happened to say.
 *
 * `todo` cases are known gaps with the *correct* expectation. They are reported but do
 * not fail the run; flip them to plain cases as the parser learns them.
 */

const seed = JSON.parse(readFileSync(geoDataPath('gazetteer.json'), 'utf8')) as {
  rows: [number | null, string, string | null, string, number, number, number][];
};
const gazetteer = Gazetteer.fromSeed(
  seed.rows.map(([, name, oblast, place, population, lat, lon]) => ({
    name, oblast, place, population, lat, lon,
  })),
);

interface Expect {
  type?: string;
  count?: number;
  relation?: string;
  /** Where the target is or is going. null asserts there is none (launch origins). */
  to?: string | null;
  /** null asserts no origin, i.e. no course invented from a neighbouring group. */
  from?: string | null;
  /** Compass course, ±10°. */
  course?: number;
}

function matches(t: ParsedTarget, e: Expect): boolean {
  if (e.type !== undefined && t.type !== e.type) return false;
  if (e.count !== undefined && t.count !== e.count) return false;
  if (e.relation !== undefined && t.relation !== e.relation) return false;
  if (e.to !== undefined && t.toName !== e.to) return false;
  if (e.from !== undefined && t.fromName !== e.from) return false;
  if (e.course !== undefined) {
    if (t.courseDeg === null) return false;
    const d = Math.abs(((t.courseDeg - e.course + 540) % 360) - 180);
    if (d > 10) return false;
  }
  return true;
}

const show = (ts: ParsedTarget[]) =>
  ts.map((t) => `${t.count}x ${t.type} ${t.relation} ${t.fromName ?? ''}>${t.toName ?? ''}`).join('; ');

/** Each expectation must be met by a distinct target, and nothing extra may appear. */
function expectExactly(text: string, expected: Expect[]): void {
  const { targets } = parseMessage(text, gazetteer);
  const left = [...targets];
  for (const e of expected) {
    const i = left.findIndex((t) => matches(t, e));
    assert.ok(i >= 0, `missing ${JSON.stringify(e)} in [${show(targets)}]`);
    left.splice(i, 1);
  }
  assert.equal(left.length, 0, `unexpected targets: [${show(left)}]`);
}

function expectNone(text: string): void {
  const result = parseMessage(text, gazetteer);
  assert.equal(result.targets.length, 0, `expected nothing, got [${show(result.targets)}]`);
  assert.equal(result.needsLlm, false, 'must not be handed to the LLM either');
}

describe("live reports", () => {
  test("kpszsu/77810", () => {
    expectExactly(
      "🛵 Ударні БпЛА на північному сході Запоріжжя вектором руху на Дніпро.",
      [
      { type: "uav", relation: "towards", to: "Дніпро" },
      ],
    );
  });
  test("sectorv666/58394", () => {
    expectExactly(
      "Сумщина:\nРеактивний БпЛА курсом на Угроїди\nРеактивний БпЛА курсом на Краснопілля\n\nЧернігівщина:\nРеактивний БпЛА курсом на Добрянку\nРеактивний БпЛА курсом на Славутич",
      [
      { type: "jet_uav", to: "Угроїди" },
      { type: "jet_uav", to: "Краснопілля" },
      { type: "jet_uav", to: "Добрянка" },
      { type: "jet_uav", to: "Славутич" },
      ],
    );
  });
  test("sectorv666/58138", () => {
    expectExactly(
      "КАБи на Оріхів - Запорізька область",
      [
      { type: "kab", relation: "towards", to: "Оріхів" },
      ],
    );
  });
  test("kpszsu/77768", () => {
    expectExactly(
      "🏍 Миколаївщина: реактивний БпЛА ➡️ курсом на Доманівку.",
      [
      { type: "jet_uav", relation: "towards", to: "Доманівка" },
      ],
    );
  });
  test("sectorv666/58035", () => {
    expectExactly(
      "Реактивний над Кропивницьким",
      [
      { type: "jet_uav", relation: "over", to: "Кропивницький" },
      ],
    );
  });
  test("kpszsu/78227", () => {
    expectExactly(
      "🏍 Реактивний БпЛА на Нікополь зі сходу.",
      [
      { type: "jet_uav", relation: "towards", to: "Нікополь" },
      ],
    );
  });
  test("sectorv666/58383", () => {
    expectExactly(
      "Донеччина 2 шахеда на Краматорськ",
      [
      { type: "uav", count: 2, relation: "towards", to: "Краматорськ" },
      ],
    );
  });
  test("kpszsu/77886", () => {
    expectExactly(
      "🏍 Реактивні БпЛА на північному сході Полтавщини вектором руху на Миргород",
      [
      { type: "jet_uav", relation: "towards", to: "Миргород" },
      ],
    );
  });
  test("kpszsu/77994", () => {
    expectExactly(
      "🛵 Ударний БпЛА на півдні Кіровоградщини у напрямку Новоукраїнки.",
      [
      { type: "uav", relation: "towards", to: "Новоукраїнка" },
      ],
    );
  });
  test("kozakchornobay/153049", () => {
    expectExactly(
      "✈️реактивний на Вишгород\n\nПідписатися на Козака Чорнобая🔱",
      [
      { type: "jet_uav", relation: "towards", to: "Вишгород" },
      ],
    );
  });
  test("sectorv666/58323", () => {
    expectExactly(
      "Чернігівщина: 10 на Борзну, 1 біля Сновська, 2 повз Кіпті на водосховище\n\nКиївщина: 1 на Переяслав\n\nВолинь: 1 на Любешів з Рівненщини\n\nЛьвівщина: 1 на Лопатин з Рівненщини",
      [
      { type: "uav", count: 10, to: "Борзна" },
      { count: 1, relation: "over", to: "Сновськ" },
      { to: "Переяслав" },
      { to: "Любешів" },
      { to: "Лопатин" },
      ],
    );
  });
  test("sectorv666/57935", () => {
    expectExactly(
      "Реактивний БПЛА на Сумщині в районі Охтирки",
      [
      { type: "jet_uav", relation: "over", to: "Охтирка" },
      ],
    );
  });
  test("kpszsu/77774", () => {
    expectExactly(
      "🏍Реактивний БпЛА на Вознесенськ з півночі.",
      [
      { type: "jet_uav", relation: "towards", to: "Вознесенськ", course: 180 },
      ],
    );
  });
  test("kozakchornobay/152865", () => {
    expectExactly(
      "✈️Одещина реактивний на Гандрабури\n\nПідписатися на Козака Чорнобая🔱",
      [
      { type: "jet_uav", relation: "towards", to: "Гандрабури" },
      ],
    );
  });
  test("kpszsu/77921", () => {
    expectExactly(
      "🛵 Сумщина: ударні БпЛА повз Кролевець курсом на захід (Чернігівщина).",
      [
      { type: "uav", relation: "past", to: "Кролевець", course: 270 },
      ],
    );
  });
  test("kpszsu/77968", () => {
    expectExactly(
      "🛵 БпЛА на Рівненщині ➡️ курсом на Дубно.",
      [
      { type: "uav", relation: "towards", to: "Дубно" },
      ],
    );
  });
  test("sectorv666/57940", () => {
    expectExactly(
      "Полтавщина: бандероль на Шишаки\n\nКіровоградщина: бандероль на Світловодськ\n\nЧеркащина: бандероль на Чигирин",
      [
      { type: "cruise", to: "Шишаки" },
      { type: "cruise", to: "Світловодськ" },
      { type: "cruise", to: "Чигирин" },
      ],
    );
  });
  test("kpszsu/77920", () => {
    expectExactly(
      "🏍 Житомирщина - ударні БпЛА повз н.п. Нова Борова, західним курсом.",
      [
      { type: "uav", relation: "past", to: "Нова Борова", course: 270 },
      ],
    );
  });
  test("kpszsu/77755", () => {
    expectExactly(
      "🏍 Реактивний БпЛА на Київщині ( Борова) курс на Білу Церкву.",
      [
      { type: "jet_uav", relation: "towards", to: "Біла Церква" },
      ],
    );
  });
  test("kpszsu/77887", () => {
    expectExactly(
      "🛵 Кіровоградщина: БпЛА ➡️ курсом на н.п. Помічна з півдня.",
      [
      { type: "uav", relation: "towards", to: "Помічна", course: 0 },
      ],
    );
  });
  test("sectorv666/58337", () => {
    expectExactly(
      "Полтавщина: 1 на Нехворощу, 1 на Пирятин\n\nВінниччина: 2 на Козятин\n\nСумщина: 1 на Конотоп, 1 на Кролевець\n\nКиївщина: 1 нв Богуслав",
      [
      { count: 1, to: "Нехвороща" },
      { count: 1, to: "Пирятин" },
      { count: 2, to: "Козятин" },
      { count: 1, to: "Конотоп" },
      { count: 1, to: "Кролевець" },
      ],
    );
  });
  test("kpszsu/77668", () => {
    expectExactly(
      "🚀 Баражуючий боєприпас типу \"Бандероль\" на Полтавщині в р-ні Великих Сорочинців курсом на Миргород",
      [
      { type: "cruise", relation: "towards", from: "Великі Сорочинці", to: "Миргород" },
      ],
    );
  });
  test("kpszsu/78243", () => {
    expectExactly(
      "🏍 Реактивний БпЛА на Білу Церкву з півдня",
      [
      { type: "jet_uav", relation: "towards", to: "Біла Церква", course: 0 },
      ],
    );
  });
  test("sectorv666/57988", () => {
    expectExactly(
      "+ Київщина: реактивний на Фастів",
      [
      { type: "jet_uav", relation: "towards", to: "Фастів" },
      ],
    );
  });
  test("kpszsu/77838", () => {
    expectExactly(
      "🏍 Реактивні БпЛА у напрямку Затока/Сергіївка з акваторії Чорного моря.",
      [
      { type: "jet_uav", relation: "towards", to: "Затока" },
      ],
    );
  });
  test("sectorv666/58375", () => {
    expectExactly(
      "Житомирщина:\nРеактивний БпЛА курсом на Довбиш",
      [
      { type: "jet_uav", relation: "towards", to: "Довбиш" },
      ],
    );
  });
  test("sectorv666/58071", () => {
    expectExactly(
      "Чернігівщина: реактивний кружляє в районі Ріпок",
      [
      { type: "jet_uav", relation: "over", to: "Ріпки" },
      ],
    );
  });
  test("sectorv666/58266", () => {
    expectExactly(
      "Сумщина: 4 на Лебедин, 6 на Кролевець\n\nЧернігівщина: 4 на Ріпки, 8 на Березну\n\nКиївщина: 1 на Страхолісся\n\nЖитомирщина: 1 на Коростень\n\nПолтавщина: 1 на Пирятин, 1 біля Нових Санжар\n\nКіровоградщина: 1 на Новоукраїнку",
      [
      { count: 4, to: "Лебедин", from: null },
      { count: 6, to: "Кролевець" },
      { count: 4, to: "Ріпки", from: null },
      { count: 8, to: "Березна" },
      { count: 1, to: "Коростень" },
      { count: 1, to: "Пирятин", from: null },
      { count: 1, relation: "over", to: "Нові Санжари" },
      { count: 1, to: "Новоукраїнка" },
      ],
    );
  });
  test("sectorv666/58284", () => {
    expectExactly(
      "Сумщина: 8 біля Кролевця, 1 на Лебедин\n\nЧернігівщина: 1 на Сосницю, 3 на Березну, 3 на Сорокошичі\n\nРівненщина: 2 повз Костопіль на Рівне\n\nЧеркащина: 1 біля Жашкова, 1 на Драбів\n\nКіровоградщина: 1 на Кроп з півночі\n\nПолтавщина: 1 кружляє біля Полтави\n\nКиївщина: 1 на Іванків\n\nМиколаївщина: 1 на Миколаїв\n\nВінниччина: 1 на Тульчин",
      [
      { count: 8, relation: "over", to: "Кролевець" },
      { count: 1, to: "Лебедин", from: null },
      { to: "Сосниця" },
      { count: 3, to: "Березна" },
      { count: 2, from: "Костопіль", to: "Рівне" },
      { relation: "over", to: "Жашків" },
      { to: "Драбів", from: null },
      { relation: "over", to: "Полтава" },
      { to: "Іванків" },
      { to: "Миколаїв" },
      { to: "Тульчин" },
      ],
    );
  });
  test("kozakchornobay/153016", () => {
    const { targets } = parseMessage("✈️Миколаївщина\nреактивний в районі Тронки\n\n✈️Запорізька область\nреактивний в районі Вільнянська\n\n✈️Київщина\n2 реактивних з Черкащини на Ставище\nреактивний на околицях Білої Церкви на Фастів.\nреактивний на Чорнобиль\n\n✈️Чернігівщина\nреактивний в районі Гончарівського\nреактивний в районі Ріпок\n\n✈️Харківщина\n2 шахеда на Гути Богодухів\n\nПідписатися на Козака Чорнобая🔱", gazetteer);
    const names = targets.map((t) => t.toName);
    assert.ok(names.includes('Ріпки'), show(targets));
    assert.ok(names.includes('Гончарівське'), show(targets));
  });
});

describe("launch reports name origins, never positions", () => {
  test("kozakchornobay/152795", () => {
    expectExactly(
      "✈️пуски шахедів з наступних локацій\n8 шахедів з Донецька, ймовірно реактивні\n8 шахедів з Орловщини\n2 шахеда з Міллерово\n\nПідписатися на Козака Чорнобая🔱",
      [
      { count: 8, to: null },
      { count: 8, to: null },
      { count: 2, to: null },
      ],
    );
  });
});

describe("a live line next to a lost one keeps only the live one", () => {
  test("kozakchornobay/152805", () => {
    expectExactly(
      "На Санжейку мінус\nТри залишилось в бік Затоки\n\nПідписатися на Козака Чорнобая🔱",
      [
      { count: 3, relation: "towards", to: "Затока" },
      ],
    );
  });
  test("kozakchornobay/152737", () => {
    expectExactly(
      "📻по цьому мінус\n\n✈️але є ще один в морі, курс Чорноморськ Санжейка Лиманка\n\nПідписатися на Козака Чорнобая🔱",
      [
      { relation: "towards", to: "Чорноморськ" },
      ],
    );
  });
  test("sectorv666/58145", () => {
    expectExactly(
      "Чернігівщина: бандероль на Борзну\n\nДруга зникла",
      [
      { type: "cruise", to: "Борзна" },
      ],
    );
  });
  test("kozakchornobay/152421", () => {
    expectExactly(
      "📻🛸Рівненщина станом на тепер локаційно чисто\n\n🛸Житомирщина\nшахед звичайний на Звягель, далі ймовірно на Хмельниччину полетить\n\nПідписатися на Козака Чорнобая🔱",
      [
      { type: "uav", to: "Звягель" },
      ],
    );
  });
});

describe("all-clear, lost, clean and fundraising messages yield nothing", () => {
  test("kozakchornobay/152642 — відбій тривоги", () => expectNone("🟢Одещина відбій тривоги\n\nПідписатися на Козака Чорнобая🔱"));
  test("kozakchornobay/152401 — відбій загрози", () => expectNone("🟢відбій загрози по балістиці бандеролях та калібрах для Одещини\n\nПідписатися на Козака Чорнобая🔱"));
  test("kozakchornobay/152910 — відбій загрози КАБ", () => expectNone("🟢⚠️відбій загрози застосування КАбів по Одещині\n\nПідписатися на Козака Чорнобая🔱"));
  test("sectorv666/58297 — чисто", () => expectNone("По Бандеролям чисто"));
  test("sectorv666/57929 — чисто", () => expectNone("Київщина та столиця - чисто"));
  test("kozakchornobay/153014 — локаційно чисто", () => expectNone("📻✈️Одещина локаційно чисто по шахедах на півночі станом на тепер\n\nПідписатися на Козака Чорнобая🔱"));
  test("kozakchornobay/152727 — мінус: target lost", () => expectNone("📻✈️Одеський район локаційно чисто\n\nмінус по шахеду на Барабой\n\nПідписатися на Козака Чорнобая🔱"));
  test("kozakchornobay/152381 — мінус: target lost", () => expectNone("мінус по реактивному на Чорноморськ, почули\n\nПідписатися на Козака Чорнобая🔱"));
  test("sectorv666/58313 — зник: target vanished", () => expectNone("На Тернопільщині - зник"));
  test("sectorv666/58309 — зник", () => expectNone("Цей зник"));
  test("kozakchornobay/153032 — зникла локаційно", () => expectNone("зникла локаційно\n\nПідписатися на Козака Чорнобая🔱"));
  test("kozakchornobay/152500 — не фіксується", () => expectNone("Не фіксується більше\n\nПідписатися на Козака Чорнобая🔱"));
  test("kozakchornobay/152898 — без фіксації", () => expectNone("📻❗️Бандеролі станом на тепер без фіксації\n\nПідписатися на Козака Чорнобая🔱"));
  test("sectorv666/58354 — без фіксації", () => expectNone("Станом на зараз - без фіксації шахів в ППУ"));
  test("kozakchornobay/152613 — threat outlook, no target", () => expectNone("🟢⚠️по стратавіа без загрози на цю ніч\n\n🟢🚤ракетоносії не виводили\n\n🔴✈️по шахедах загроза є, все без змін\n\n🔴⚠️по балістиці загроза є завжди і це швидко, враховуйте це\n\nПідписатися на Козака Чорнобая🔱"));
  test("kozakchornobay/152489 — fundraising", () => expectNone("Немає бажаючих підтримати Чорнобая?\n\nнуль донатів на жаль станом на зараз\n\n💰PrivatBank: 5168752007622155\n\n💰Paypal: policeguard777@gmail.com\n\n💰Карта моно: 4874100020997063"));
  test("kozakchornobay/152995 — fundraising report", () => expectNone("🟢Відеозвіт по збору на два Старлінки для 115 бригади 🇺🇦\n\nЗбір був у серпні на суму 20 800 грн\n\nДякуємо тим, хто донатив💛\n\n🔺🔺всі звіти по зборах каналу тут"));
});

describe("air-defence results are sensitive and never parsed", () => {
  test("kozakchornobay/152742 — збиття", () => {
    const text = "💥🛵Епічний момент збиття шахеда екіпажем гелікоптера 18-ої бригади армійської авіації\n\nПідписатися на Козака Чорнобая🔱";
    assert.equal(isSensitive(text), true);
    expectNone(text);
  });
  test("kpszsu/78070 — ЗБИТО/ПОДАВЛЕНО daily summary", () => {
    const text = "⚡️ ЗБИТО/ПОДАВЛЕНО 409 ЦІЛЕЙ ПРОТИВНИКА\n➖➖➖➖➖➖➖➖➖➖\nУ ніч на 13 вересня (з 18:00 12 вересня) противник атакував 453 ударними БпЛА типу Shahed (в т.ч. реактивними), Гербера, дронами-імітаторами типу “Пародія”, а також S8000 \"Бандероль\" із напрямків: Шаталово, Орел, Курськ, Приморсько-Ахтарськ - рф; ТОТ АР Крим – Гвардійське та акваторія Азовського Моря.\n\nПовітряний напад відбивали авіація, зенітні ракетні війська, підрозділи РЕБ та безпілотних систем, мобільні вогневі групи Сил оборони України.\n\n💥 За попередніми даними, станом на 08:00, протиповітряною обороною збито/подавлено 405 ворожих БпЛА типу Shahed, Гербера, дронів інших типів та 4 S8000 \"Бандероль\".\n\nЗафіксовано влучання засобів повітряного нападу противника на 13 локаціях, а також падіння збитих (уламки) на 7 локаціях.\n\nАтака триває, в повітряному просторі ворожі БпЛА. Дотримуйтесь правил безпеки!\n\n✊ Тримаймо небо!\n🇺🇦 Разом – до перемоги!";
    assert.equal(isSensitive(text), true);
    expectNone(text);
  });
  test("kozakchornobay/152721 — попередньо збиття", () => {
    const text = "📻✈️Одеський район локаційно чисто станом на тепер\n\nдорозвідка по шахеду на Санжейку, попередньо збиття\n\nв морі без фіксації шахедів, повинен бути відбій тривоги\n\nПідписатися на Козака Чорнобая🔱";
    assert.equal(isSensitive(text), true);
    expectNone(text);
  });
  test("sectorv666/57976 — намагаються збивати", () => {
    const text = "Вже 30 хвилин розвідувальний БпЛА над м.Дніпро, наші намагаються збивати.";
    assert.equal(isSensitive(text), true);
    expectNone(text);
  });
});

describe("known gaps", () => {
  test("kozakchornobay/152685", { todo: "day summary listing the attack's main targets is history, not a live report" }, () => expectNone("❗️Карта руху ракет та дронів протягом дня\n\nПопередньо до 700 шахедів було за сьогодні\n\nОсновні цілі атаки — Кривий Ріг, Запоріжжя, Затока, Одеса, Ковель, Луцьк\n\nПідписатися на Козака Чорнобая🔱"));
  test("kozakchornobay/152871", { todo: "\"Особливо обережно найближчі дні: Київ область\" is an outlook, not a target" }, () => expectNone("🟢⚠️по стратавіа без загрози на цю ніч\n\n🟢🚤ракетоносії не виводили\n\n🔴✈️по шахедах загроза є, все без змін\nстаном на тепер масованих пусків немає\n\n🔴⚠️по балістиці загроза є завжди і це швидко, враховуйте це\n\nОсобливо обережно найближчі дні: Київ область, Полтава область, Дніпро область\n\n❗️⚠️До застосування готові до 30 балістичних ракет\n\nПідписатися на Козака Чорнобая🔱"));
  test("kozakchornobay/152915", { todo: "\"Тузловських Лиманів\" are the Tuzla lagoons, not the town of Lyman" }, () => {
    const { targets } = parseMessage("✈️Одещина\nшахед на Курган\nшахед на Затоку\n5 шахедів навпроти Тузловських Лиманів\n\nПідписатися на Козака Чорнобая🔱", gazetteer);
    assert.ok(!targets.some((t) => t.toName === "Лиман"), show(targets));
  });
  test("kozakchornobay/152861", { todo: "\"на Суху Журівку\" must not shrink to the village Суха" }, () => {
    const { targets } = parseMessage("✈️Одещина реактивний на Суху Журівку\n\nзагалом він транзитний без загрози\n\nПідписатися на Козака Чорнобая🔱", gazetteer);
    assert.ok(!targets.some((t) => t.toName === "Суха"), show(targets));
  });
  test("kpszsu/78140", { todo: "\"КАБ на Запоріжжя\" means the city, not the oblast centre" }, () => {
    const { targets } = parseMessage("💣 Пуски керованих авіаційних бомб ворожою тактичною авіацією на Запоріжжя.", gazetteer);
    assert.ok(targets.some((t) => t.toName === "Запоріжжя"), show(targets));
  });
  test("kpszsu/78057", { todo: "\"на Львівщину н.п. Броди\" names the settlement; the oblast is the coarse fallback" }, () => {
    const { targets } = parseMessage("🛵 Ударний БпЛА з Рівненщини ➡️ на Львівщину н.п. Броди.", gazetteer);
    assert.ok(targets.some((t) => t.toName === "Броди"), show(targets));
  });
  test("kpszsu/77692", { todo: "\"⚠Запоріжжя / реактивний над містом!\" is over the header city" }, () => {
    const { targets } = parseMessage("⚠Запоріжжя\n🏍 Реактивний БпЛА над містом!", gazetteer);
    assert.ok(targets.some((t) => t.toName === "Запоріжжя"), show(targets));
  });
});
