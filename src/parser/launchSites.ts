import { normalise } from './morphology.js';

/**
 * Enemy launch sites outside Ukraine.
 *
 * The gazetteer holds Ukrainian settlements only, so "пуски шахедів з Курська,
 * Брянську та Орла" resolved to nothing and the launch was dropped entirely — while
 * these are the sites most of a night's Shaheds actually come from. Over the stored
 * corpus the channels name Oryol 42 times, Kursk 19, Shatalovo 14, Primorsko-Akhtarsk
 * 15, Bryansk 10.
 *
 * Only launch origins, never destinations: a marker here says "this is where they
 * took off", which is two to four hours of warning and the earliest signal this tool
 * can give. They resolve coarsely on purpose — a launch site is an airfield or a
 * region, and any Ukrainian settlement outranks them.
 *
 * Forms are listed rather than generated. The morphology rules are built for
 * Ukrainian toponyms and these are mostly Russian names as Ukrainian channels decline
 * them, plus colloquial region forms ("Орловщина", "Курщина") that no rule produces.
 */
export interface LaunchSite {
  name: string;
  lat: number;
  lon: number;
  forms: string[];
}

export const LAUNCH_SITES: LaunchSite[] = [
  {
    name: 'Орел',
    lat: 52.967, lon: 36.07,
    forms: ['орел', 'орла', 'орлі', 'орлом', 'орловська', 'орловщина', 'орловщини',
            'орловської', 'орловська область', 'орловської області'],
  },
  {
    // Khalino airbase, which the channels name as often as the city itself.
    name: 'Курськ',
    lat: 51.75, lon: 36.295,
    forms: ['курськ', 'курська', 'курську', 'курщина', 'курщини', 'халино', 'халіно',
            'курська область', 'курської області'],
  },
  {
    name: 'Шаталово',
    lat: 54.363, lon: 32.435,
    forms: ['шаталово', 'шаталове', 'шаталова', 'смоленськ', 'смоленська', 'смоленщина',
            'смоленщини', 'смоленська область', 'смоленської області'],
  },
  {
    name: 'Приморсько-Ахтарськ',
    lat: 46.046, lon: 38.171,
    forms: ['приморсько-ахтарськ', 'приморсько-ахтарська', 'приморсько-ахтарського',
            'ахтарськ', 'ахтарська', 'ахтарського'],
  },
  {
    name: 'Міллерово',
    lat: 48.949, lon: 40.398,
    forms: ['міллерово', 'міллєрово', 'міллерова', 'міллєрова'],
  },
  {
    name: 'Брянськ',
    lat: 53.243, lon: 34.364,
    forms: ['брянськ', 'брянська', 'брянську', 'брянщина', 'брянщини',
            'брянська область', 'брянської області'],
  },
  {
    name: 'Навля',
    lat: 52.828, lon: 34.489,
    forms: ['навля', 'навлі', 'навлю'],
  },
  {
    name: 'Ростов',
    lat: 47.235, lon: 39.701,
    forms: ['ростов', 'ростова', 'ростовська', 'ростовщина', 'ростовщини',
            'ростовська область', 'ростовської області'],
  },
  {
    name: 'Таганрог',
    lat: 47.236, lon: 38.897,
    forms: ['таганрог', 'таганрога', 'таганрозі'],
  },
  {
    name: 'Єйськ',
    lat: 46.711, lon: 38.274,
    forms: ['єйськ', 'ейськ', 'єйська', 'єйську'],
  },
  /*
   * Occupied Crimea. Launches from here are real and are the only ones that happen on
   * Ukrainian soil — which is why the "no launches inside Ukraine" rule is enforced by
   * membership of this list rather than by a border test. Both are in the gazetteer as
   * ordinary settlements, and inside a launch report this entry has to win.
   */
  {
    name: 'Чауда',
    lat: 45.032, lon: 36.011,
    forms: ['чауда', 'чауди', 'чауді', 'чаудою'],
  },
  {
    name: 'Гвардійське',
    lat: 45.117, lon: 33.983,
    forms: ['гвардійське', 'гвардійського', 'гвардійському'],
  },
];

/** Does any window of this text name a site? Used to decide whether brackets matter. */
function hasAnyMatch(text: string): boolean {
  const words = normalise(text).split(/\s+/)
    .map((w) => w.replace(/^[«"(]+|[»".,;:!?)]+$/g, ''))
    .filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    for (let take = Math.min(3, words.length - i); take >= 1; take--) {
      if (BY_FORM.has(words.slice(i, i + take).join(' '))) return true;
    }
  }
  return false;
}

const BY_FORM = new Map<string, LaunchSite>();
for (const site of LAUNCH_SITES) {
  for (const form of site.forms) BY_FORM.set(normalise(form), site);
}

/**
 * Match the leading words of a phrase against the launch sites.
 *
 * Longest first, so "Курська область" beats the bare "Курська". Exact form matching
 * rather than a stem: `курс` is one of the commonest words in these channels and a
 * prefix rule would turn every stated course into a launch from Kursk.
 */
export function matchLaunchSite(phrase: string): LaunchSite | undefined {
  const words = normalise(phrase)
    .split(/\s+/)
    .map((w) => w.replace(/^[«"(]+|[»".,;:!?)]+$/g, ''))
    .filter(Boolean);

  for (let take = Math.min(words.length, 3); take >= 1; take--) {
    const hit = BY_FORM.get(words.slice(0, take).join(' '));
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Every launch site named in a line, in order, without repeats.
 *
 * One message routinely lists several — "пуски шахедів з наступних локацій: 3 з
 * Смоленська, 10 з Курська, 10 з Орла" is three separate launches, and reporting only
 * the first threw away two thirds of the night's warning.
 */
export function findLaunchSites(line: string): LaunchSite[] {
  /*
   * A bracketed region names the one before it, not another launch: "з району Навля
   * (Брянська область)" is one site, and counting the bracket separately doubled it.
   * Brackets are dropped only when something outside them already matched, so a
   * message that names a site *only* in brackets still resolves.
   */
  const outside = line.replace(/\([^)]*\)/g, ' ');
  const source = matchLaunchSite(outside) || hasAnyMatch(outside) ? outside : line;

  const words = normalise(source)
    .split(/\s+/)
    .map((w) => w.replace(/^[«"(]+|[»".,;:!?)]+$/g, ''))
    .filter(Boolean);

  const found: LaunchSite[] = [];
  for (let i = 0; i < words.length; i++) {
    for (let take = Math.min(3, words.length - i); take >= 1; take--) {
      const hit = BY_FORM.get(words.slice(i, i + take).join(' '));
      if (hit) {
        if (!found.includes(hit)) found.push(hit);
        i += take - 1;
        break;
      }
    }
  }
  return found;
}

/**
 * Is this the name of a site weapons are actually launched *from*?
 *
 * The map drew "Пуск · КАБ" on Kharkiv, because the line said "пуск" and Kharkiv was
 * the only place in it. A KAB over Kharkiv is a strike on Kharkiv — the exact class of
 * thing this tool must never display — and it read as an enemy launch site sitting in
 * a Ukrainian city.
 *
 * So a launch is drawn only at a place on this list. Every entry is in Russia or in
 * occupied territory, which is the whole of the user's rule: launches do not happen on
 * ground Ukraine holds. A line naming a launch from anywhere else still yields an
 * origin with no position — invisible on the map — and still reaches the feed as text.
 */
export function isKnownLaunchSite(name: string): boolean {
  const wanted = normalise(name);
  return LAUNCH_SITES.some((site) => normalise(site.name) === wanted);
}
