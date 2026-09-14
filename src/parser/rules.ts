import type { Gazetteer, Resolution } from './gazetteer.js';
import { normalise } from './morphology.js';
import { matchOblast } from './oblasts.js';
import { BOUNDARY_LEFT } from './regex.js';
import { classifyType, extractCount, inferBareType, type TargetType } from './targetTypes.js';
import { extractApproachCourse, extractCourse } from './compass.js';
import { matchWater } from './water.js';
import { findLaunchSites, isKnownLaunchSite, matchLaunchSite } from './launchSites.js';

/** How a target relates to the place named. */
export type Relation = 'towards' | 'past' | 'through' | 'over' | 'from' | 'launch';

export interface ParsedTarget {
  type: TargetType;
  rawType: string | null;
  count: number;
  oblast: string | null;
  relation: Relation;
  toName: string | null;
  toLat: number | null;
  toLon: number | null;
  fromName: string | null;
  fromLat: number | null;
  fromLon: number | null;
  courseDeg: number | null;
  confidence: number;
  /** Set only when the message states a clock time; otherwise the post time is used. */
  observedAt?: number;
  sourceLine: string;
}

/**
 * Relation cues, longest-first so "курсом на" is consumed before the bare "на".
 * Every pattern is built with an explicit Unicode boundary — `\b` does not work
 * against Cyrillic and silently matches nothing.
 */
const RELATION_CUES: { relation: Relation; source: string }[] = [
  { relation: 'towards', source: 'курс(?:ом)?\\s+на' },
  /*
   * "курс Крижопіль" — a destination with the preposition dropped, which these
   * channels write as often as the full form. Safe next to "курс західний" only
   * because the place pattern is case-sensitive: the compass word is lowercase and
   * falls through to the course rules, the settlement is capitalised and does not.
   */
  { relation: 'towards', source: 'курс(?:ом)?' },
  { relation: 'towards', source: '[ву]\\s+напрямку(?:\\s+на)?' },
  { relation: 'towards', source: 'напрямком\\s+на' },
  { relation: 'towards', source: '[ву]\\s+б[іi]к' },
  // "наближаються до Броварів", "підлітає до Ніжина" — the single most common way
  // these channels phrase an approach, and the bare preposition is safe because the
  // place pattern is case-sensitive ("до цілі" is lowercase and falls through).
  { relation: 'towards', source: 'до' },
  { relation: 'from', source: 'з\\s+боку' },
  { relation: 'from', source: 'зі\\s+сторони' },
  { relation: 'from', source: 'з\\s+акваторі[її]' },
  /*
   * A bare "з" is safe only because the place pattern is case-sensitive: "з
   * Херсонщини" names an origin, while "з півночі" and "з заходу" are lowercase and
   * fall through to the compass rules that read them as an approach bearing.
   */
  { relation: 'from', source: 'з|із|зі' },
  { relation: 'past', source: 'повз' },
  { relation: 'through', source: 'через' },
  { relation: 'over', source: 'над' },
  // "в р-ні Павлограду", "поблизу Ніжина", "північніше Нікополя" — all say where the
  // target currently is rather than where it is going.
  { relation: 'over', source: '[ву]\\s+р[-–—]?н[іi]?\\.?(?:\\s+н\\.?п\\.?)?' },
  { relation: 'over', source: '[ву]\\s+район[іi]?' },
  { relation: 'over', source: 'поблизу|біля|неподалік' },
  // "на межі Одеської та Миколаївської областей" — a position between two regions;
  // the first one names it well enough, and the heading comes from the stated course.
  { relation: 'over', source: 'на\\s+меж[іi]' },
  { relation: 'over', source: '(?:північн|південн|західн|східн)[а-яіїєґ]*іше' },
  // "на півдні Сумщини" locates the target inside a region rather than sending it
  // there; the heading then comes from a stated compass course.
  // Both cases occur: "на півдні Одещини" (locative) and "на південь Одещини"
  // (accusative). Either way it locates the target inside the region.
  { relation: 'over', source: 'на\\s+(?:півноч[іi]|півдн[іi]|сход[іi]|заход[іi]|північ|південь|схід|захід)' },
  { relation: 'towards', source: 'на' },
  // Last resort: a bare "в"/"у" before a capitalised name — "з Броварів у центр
  // Києва". Every more specific "в ..." cue is matched before this one.
  { relation: 'towards', source: '[ву]' },
];

/*
 * Cue and place are matched by two separate expressions, and that separation is the
 * whole point.
 *
 * They used to be one pattern ending in `([А-ЯІЇЄҐA-Z]\S*(?:\s+[А-ЯІЇЄҐ]\S*){0,2})`
 * under the `i` flag — and `i` makes a Cyrillic *uppercase range* match lowercase
 * too, so the "capitalised" requirement was silently void. "повз Димер в напрямку
 * Вишгорода" captured the place as "Димер в напрямку": the continuation words were
 * swallowed, the second cue was never seen, and the line yielded a waypoint with no
 * destination — hence no course. Same family as the `\b` bug: a regex assumption
 * that quietly does not hold for Cyrillic.
 *
 * So cues match case-insensitively (they are lowercase words), and the place is then
 * read off the remaining text with a case-SENSITIVE pattern.
 */
const CUE_RE = new RegExp(
  `${BOUNDARY_LEFT}(${RELATION_CUES.map((c) => c.source).join('|')})\\s+`,
  'giu',
);

/*
 * Filler between the cue and the name: "у напрямку центру Києва", "на н.п. Гуляйполе".
 * Without it the capitalised name is never reached and the cue is discarded.
 */
const PLACE_FILLER =
  '(?:(?:центр[ауі]?|окол[иі]ц[іь]|район[уаі]?|р-?н[уаі]?|сел[оаі]|міст[оаеі]|смт)\\s+' +
  '|(?:н\\.?\\s?п\\.?|м\\.|с\\.|смт)\\s*)?';
const CAP_WORD = '[А-ЯІЇЄҐA-Z][^\\s,.;:!?()]*';
/** `u` but deliberately NOT `i` — the capitalisation is the signal. */
const PLACE_RE = new RegExp(
  `^${PLACE_FILLER}(${CAP_WORD}(?:\\s+${CAP_WORD}){0,2}|міст[оаиуе]м?)`,
  'u',
);

/*
 * A cue can point at a compass direction before it points at a place: "курсом на
 * північний-Захід (Рудниця Крижопіль)" states the heading first and names the
 * settlements second. Skipping the direction — and the bracket the channels put the
 * names in — is what lets the place behind it be seen at all.
 */
const LEADING_COMPASS =
  /^(?:північн|південн|східн|західн|північ|південь|схід|захід)[а-яіїєґ]*(?:\s*[-–—]?\s*(?:північн|південн|східн|західн|північ|південь|схід|захід)[а-яіїєґ]*)?/iu;
const LEADING_NOISE = /^[\s(«"„\-–—,:]+/u;

/*
 * The phrases a cue might point at, best guess first.
 *
 * Skipping a leading direction cannot be unconditional: "Південне" is a town in Odesa
 * oblast and "на Південне/Чорноморськ/Одесу" would lose its destination to a rule
 * meant for "на північний-Захід (Рудниця...)". So the literal reading is offered
 * first and the direction-skipped one second, and resolution picks whichever names a
 * real place.
 */
function placeCandidates(text: string): string[] {
  const trimmed = text.replace(LEADING_NOISE, '');
  const direct = PLACE_RE.exec(trimmed)?.[1];

  const beyond = trimmed.replace(LEADING_COMPASS, '').replace(LEADING_NOISE, '');
  const skipped = beyond === trimmed ? undefined : PLACE_RE.exec(beyond)?.[1];

  return [...new Set([direct, skipped].filter((v): v is string => v !== undefined))];
}

/*
 * A bare "на" is the one cue whose meaning depends on the case of what follows.
 * "на Одещину" (accusative) sends the target there; "на Одещині" (locative) says it
 * is already over it. Reading the locative as a destination inverted the course on
 * every "на Херсонщині у напрямку Чорного моря" — the arrow pointed inland from the
 * sea instead of out to it.
 */
const BARE_NA = /^на$/iu;
const LOCATIVE = /[іїi]$/u;

function relationFor(cue: string, phrase?: string): Relation {
  const normalised = cue.toLowerCase().replace(/\s+/g, ' ');
  if (phrase && BARE_NA.test(normalised) && LOCATIVE.test(phrase.trim())) return 'over';

  for (const { relation, source } of RELATION_CUES) {
    if (new RegExp(`^(?:${source})$`, 'iu').test(normalised)) return relation;
  }
  return 'towards';
}

/** Strongest relation wins when a line carries several ("повз X, курсом на Y"). */
const RELATION_RANK: Record<Relation, number> = {
  towards: 5, through: 4, past: 3, over: 2, from: 1, launch: 0,
};

const EMOJI = /[\p{Extended_Pictographic}️‍]/gu;
const HEADING = /^\s*([А-ЯІЇЄҐ][А-Яа-яІіЇїЄєҐґ'’-]{3,20})\s*[:\-–—]\s*/u;
/** The same, with the separator left out — and something after it, or it is not a heading. */
const BARE_OBLAST_PREFIX = /^\s*([А-ЯІЇЄҐ][А-Яа-яІіЇїЄєҐґ'’-]{3,20})\s+(?=\S)/u;

export interface ParseContext {
  gazetteer: Gazetteer;
  /** Oblast established by an earlier heading in the same message. */
  oblast: string | null;
  /** Target type established by an earlier line in the same message. */
  type: TargetType;
  /**
   * City named on its own header line, as in "⚠ Дніпро" followed by "Реактивний
   * БпЛА над містом!". Without it those messages resolve to nothing at all.
   */
  city: Resolution | null;
  /**
   * A launch report opened this message.
   *
   * These channels write one line per site under a single heading — "пуски шахедів з
   * наступних локацій:" then "3 з Смоленська", "10 з Курська" — so only the first
   * line carries the word. Without carrying it forward, every site but the first was
   * parsed as an ordinary report, found nothing in the gazetteer, and vanished.
   *
   * Deliberately consulted only when deciding whether to look for launch sites, not
   * when deciding that an origin is a launch: a message that lists launches and then
   * tracks a target in flight must not turn the second into a launch too.
   */
  launch: boolean;
}

/** Is the line nothing but this place name, give or take punctuation? */
function isBareName(line: string, name: string): boolean {
  const strip = (v: string) => normalise(v).replace(/[^\p{L}\p{N}]+/gu, '');
  return strip(line) === strip(name);
}

/** "над містом", "в напрямку міста" — refers back to the header city. */
const CITY_WORD = /^міст[оаиуе]м?$/iu;

/*
 * A launch report names where the weapons came *from*, not where they are.
 *
 * "Пуски шахедів з району Донецьку, Орла та Гвардійського" was drawing a drone
 * icon sitting on Hvardiiske — a launch site — as though a target were overhead
 * there. Same for "пуски Калібрів з акваторії Чорного моря". The place is an
 * origin, the destination is unknown, and a marker at the origin is worse than no
 * marker: it says a thing is somewhere it is not.
 */
const LAUNCH = /(?<![\p{L}\p{N}])пуск[а-яіїєґ]*/iu;

/**
 * What can be launched *from a site*, as opposed to dropped from an aircraft already
 * airborne.
 *
 * A KAB has no launch site: it is released by a jet over the front, so "пуск КАБ по
 * Харкову" describes a strike on Kharkiv, not an origin — and the map drew it as a
 * launch burst on the city. Aviation and a reconnaissance drone are the same story in
 * a different shape, and `unknown` is a guess we should not dress as a location.
 */
const LAUNCHABLE: ReadonlySet<TargetType> = new Set(['uav', 'jet_uav', 'cruise', 'ballistic']);

/**
 * The two seas, which are launch origins in their own right.
 *
 * A cruise missile fired from a ship in the Black Sea is a real launch from ground
 * nobody holds, and it is the earliest warning there is for the south coast. The
 * reservoirs on the same list are inland Ukrainian water and are not origins.
 */
const LAUNCH_WATERS: ReadonlySet<string> = new Set(['Чорне море', 'Азовське море']);

/**
 * Two conditions, both the user's: a launch marker is only for a drone or a missile,
 * and it can only stand on ground Ukraine does not hold. Membership of the launch-site
 * list is what carries the second — every entry there is in Russia or occupied Crimea
 * — with the two seas added, since open water is nobody's territory.
 *
 * Anything else naming "пуск" still yields an origin, which draws nothing, and the
 * message still reaches the feed as text. Nothing is lost but the false marker.
 */
function isLaunchOrigin(placeName: string, type: TargetType): boolean {
  if (!LAUNCHABLE.has(type)) return false;
  return isKnownLaunchSite(placeName) || LAUNCH_WATERS.has(placeName);
}

/*
 * What makes an untyped line a target report at all.
 *
 * When no weapon is named the type is `unknown`, and a bare relation cue is then not
 * enough evidence: "На Одещині та в напрямку Одеси значні затримки поїздів через
 * ворожу атаку" is a railway bulletin, and it was putting a "Ціль" marker on central
 * Odesa. A wrong pin is worse than no pin — the message still reaches the feed as
 * text either way.
 *
 * These channels' untyped reports do carry evidence: a count ("десяток на Батурин"),
 * a movement verb ("Пролітає Сорокошичі", "Вийшов за межі області"), or a target
 * noun ("Шах над Рівне", "швидкісна ціль").
 */
/** Longest line still readable as the one-line-per-drone shorthand. */
const SHORTHAND_WORDS = 8;

const UNTYPED_EVIDENCE = new RegExp(
  BOUNDARY_LEFT +
    '(?:ціл[ьіяе]|об\'єкт|шах|пролі[тч]|пролет|проходит|пішов|пішла|вийш|' +
    'рухає|рухают|летить|летять|заходит|заходят|прямує|курс|над|повз|' +
    'йде|іде|йдут|ідут|підліт|вилет|виліт|виліз|проход|зайшов|зайшла|' +
    // Counts written as words: "десяток на Батурин", "група на Ніжин".
    'десят|кільк|декілька|груп|пара|багато)',
  'iu',
);

/**
 * A target known only by where it started.
 *
 * Carries no destination, so the map draws nothing and the message still reaches the
 * feed as text — which is the specified behaviour for anything not fully resolved.
 */
function originOnly(
  place: Resolution,
  type: TargetType,
  rest: string,
  cleaned: string,
  isLaunch: boolean,
): ParsedTarget[] {
  return [{
    type,
    rawType: rawTypeOf(rest),
    count: extractCount(rest),
    oblast: place.oblast,
    relation: isLaunch ? 'launch' : 'from',
    toName: null,
    toLat: null,
    toLon: null,
    fromName: place.name,
    fromLat: place.lat,
    fromLon: place.lon,
    // Only a course the line actually states. Without a destination there is no pair
    // of points to derive one from, and a guessed bearing off a launch site is noise.
    courseDeg: extractCourse(rest),
    confidence: place.confidence,
    sourceLine: cleaned,
  }];
}

/**
 * Parse one line into zero or more targets.
 *
 * A line may open with a sticky oblast heading ("Сумщина:"), which updates the
 * context for the lines that follow, and may carry both a waypoint and a
 * destination ("БпЛА повз Путивль, курсом на Чернігівщину") — that becomes a single
 * target with an origin and a destination, which is what yields a course bearing.
 */
/**
 * A comma-separated clause begins a NEW target only when it carries its own type
 * word or its own count.
 *
 * "реактивний над Одесою кружляє, реактивний на Суми" is two targets — each clause
 * names a type — and merging them invented a 576 km Odesa->Sumy course. But
 * "БпЛА повз Путивль, курсом на Охтирку" is one target whose second clause only
 * continues the first, so it must not be split.
 */
const SELF_CONTAINED = /^\s*\d{1,3}\s*(?:х|x)?\s|^\s*(?:реактивн|бпла|шахед|герань|каб|ракет|крилат|балістик|швидкісн|ударн|розвід|авіаці)/iu;

export function parseLine(line: string, context: ParseContext): ParsedTarget[] {
  const cleaned = line.replace(EMOJI, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];

  const clauses = cleaned.split(/\s*[,;]\s+/);
  if (clauses.length > 1) {
    const standalone = clauses.filter((c) => SELF_CONTAINED.test(c));
    if (standalone.length > 1) {
      return clauses.flatMap((clause) => parseClause(clause, context));
    }
  }

  return parseClause(cleaned, context);
}

/*
 * "5 шахедів Затока міст", "Одещина реактивний Новокальчеве" — a type and a place
 * with no preposition between them. There is no relation to read, so the target is
 * recorded as being *over* the place rather than heading for it, which is the weaker
 * and safer of the two readings.
 *
 * Guarded by a recognised target type: without that this would turn any capitalised
 * word in ordinary channel chatter into a marker.
 */
function bareMention(
  rest: string,
  type: TargetType,
  inferred: boolean,
  cleaned: string,
  context: ParseContext,
): ParsedTarget[] {
  if (type === 'unknown') return [];

  for (const match of rest.matchAll(/(?<![\p{L}\p{N}])([А-ЯІЇЄҐ][^\s,.;:!?()]{2,})/gu)) {
    const place = context.gazetteer.resolve(match[1]!, context.oblast);
    if (place?.kind !== 'settlement') continue;
    if (place.oblast) context.oblast = place.oblast;

    /*
     * "Пуски шахедів з району Донецьку, Орла та Гвардійського" reaches here with no
     * cue at all; the names are launch sites and must not become positions.
     *
     * The marker is a separate question from the position: a bare place in a launch
     * report never becomes a target wherever it is, but it only earns the launch burst
     * if it is an enemy site. This is the path that put "Пуск · КАБ" on Kharkiv — the
     * other two were guarded and this one was not.
     */
    if (LAUNCH.test(rest)) {
      return originOnly(place, type, rest, cleaned, isLaunchOrigin(place.name, type));
    }

    return [{
      type,
      rawType: rawTypeOf(rest),
      count: extractCount(rest),
      oblast: place.oblast ?? context.oblast,
      relation: 'over',
      toName: place.name,
      toLat: place.lat,
      toLon: place.lon,
      fromName: null,
      fromLat: null,
      fromLon: null,
      courseDeg: extractCourse(rest) ?? extractApproachCourse(rest),
      // Lower than a cued mention: the line never said how the two relate.
      confidence: place.confidence * (inferred ? 0.7 : 0.8),
      sourceLine: cleaned,
    }];
  }
  return [];
}

/** Parse one clause into at most one target. */
function parseClause(line: string, context: ParseContext): ParsedTarget[] {
  const cleaned = line.replace(EMOJI, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];

  let rest = cleaned;

  // A leading "<Oblast>:" both sets the context and is removed from the line.
  const heading = HEADING.exec(rest);
  if (heading) {
    const oblast = matchOblast(heading[1]!);
    if (oblast) {
      context.oblast = oblast.key;
      rest = rest.slice(heading[0].length).trim();
    }
  }

  /*
   * The same heading without punctuation: "Одещина реактивний на село Красне".
   *
   * Half these channels drop the colon, and the oblast is the only thing that
   * disambiguates a name. Six villages are called Красне; without the context the
   * ranking picks the largest, which put an Odesa-oblast target 500 km away in Lviv
   * oblast. This is the disambiguator the whole gazetteer depends on, so it cannot
   * hinge on a punctuation mark the writer may or may not type.
   */
  if (!heading) {
    const first = BARE_OBLAST_PREFIX.exec(rest);
    const bareOblast = first ? matchOblast(first[1]!) : undefined;
    if (first && bareOblast) {
      context.oblast = bareOblast.key;
      rest = rest.slice(first[0].length).trim();
    }
  }

  // A line that is only a heading carries no target.
  if (!rest) return [];

  // A short line that is just a settlement name is a header ("⚠ Дніпро"), not a
  // report; remember it so a later "над містом" has something to point at.
  /*
   * A line naming a weapon is a report, never a header — "Дачне шахед" says a Shahed
   * is over Dachne. Without this guard `resolve` finds the settlement, the line is
   * filed as a header and the target disappears. It only surfaced once the oblast
   * prefix started being stripped: "Одещина Дачне шахед" used to resolve to the
   * oblast first, which is not a settlement, so it fell through by luck.
   */
  if (!CUE_RE.test(rest) && classifyType(rest, 'unknown') === 'unknown') {
    CUE_RE.lastIndex = 0;
    const asPlace = rest.length <= 30 ? context.gazetteer.resolve(rest, context.oblast) : undefined;
    /*
     * And the line must be *only* the name. "Волинь Луцьк уважно" is a warning about
     * Lutsk under a message about drones; swallowing it as a header dropped the one
     * place the writer wanted people to look at. "⚠ Дніпро" on its own line is the
     * real thing this is for.
     */
    if (asPlace?.kind === 'settlement' && isBareName(rest, asPlace.name)) {
      context.city = asPlace;
      if (asPlace.oblast) context.oblast = asPlace.oblast;
      return [];
    }
  }
  CUE_RE.lastIndex = 0;

  /*
   * A launch report naming sites outside Ukraine is handled before anything else:
   * one message routinely lists several, and each is a separate launch. "пуски
   * шахедів з наступних локацій: 3 з Смоленська, 10 з Курська, 10 з Орла" is three
   * events, and taking only the first discarded two thirds of the warning.
   */
  if (LAUNCH.test(rest)) context.launch = true;

  if (context.launch) {
    const sites = findLaunchSites(rest);
    if (sites.length > 0) {
      const launchType = classifyType(rest, context.type);
      return sites.flatMap((site) => originOnly(
        { name: site.name, lat: site.lat, lon: site.lon, oblast: null,
          kind: 'oblast', confidence: 0.5 },
        launchType, rest, cleaned, isLaunchOrigin(site.name, launchType),
      ));
    }
  }

  let type = classifyType(rest, context.type);
  let inferred = false;
  if (type === 'unknown') {
    const guess = inferBareType(rest);
    if (guess) {
      type = guess;
      inferred = true;
    }
  }
  if (type !== 'unknown' && !inferred) context.type = type;

  /*
   * No weapon named. Two shapes are still target reports and one is not.
   *
   * @sectorv666 tracks a drone wave one line per drone — "На Обухів", "Димер на
   * Вишгород", "Цей на Славутич" — with the type stated once and then dropped. Those
   * lines are almost nothing but a cue and a place, and there are hundreds of them.
   *
   * A long sentence that merely happens to contain a direction is something else:
   * "На Одещині та в напрямку Одеси значні затримки поїздів через ворожу атаку" is a
   * railway bulletin, and it was putting a marker on central Odesa. Length is the
   * discriminator that separates the two without a topic blacklist.
   */
  const words = rest.split(/\s+/).length;
  if (type === 'unknown' && !inferred && words > SHORTHAND_WORDS
      && !UNTYPED_EVIDENCE.test(rest) && extractCount(rest) < 2) {
    return [];
  }

  /*
   * `tail` is everything after the cue, kept alongside the capitalised phrase because
   * water names are half lowercase — "Чорного моря" gives up only "Чорного" to a
   * case-sensitive place pattern, which matches no sea.
   */
  CUE_RE.lastIndex = 0;
  const matches = [...rest.matchAll(CUE_RE)]
    .map((m) => {
      const tail = rest.slice(m.index + m[0].length);
      return { cue: m[1]!, phrases: placeCandidates(tail), tail };
    })
    .filter((m) => m.phrases.length > 0
      || matchWater(m.tail) !== undefined
      || (LAUNCH.test(rest) && matchLaunchSite(m.tail) !== undefined));
  if (matches.length === 0) return bareMention(rest, type, inferred, cleaned, context);

  // Two passes. An oblast named in a line is usually *context* — "БпЛА на
  // Житомирщині, змінив курс на Коростень" is over Zhytomyr oblast heading for
  // Korosten, not heading for the oblast — so oblasts are resolved first and used to
  // disambiguate the settlements, and only stand in as a destination when the line
  // names no settlement at all ("КАБи на Дніпропетровщину").
  const cues = matches.map((m) => ({
    relation: relationFor(m.cue, m.phrases[0]),
    phrases: m.phrases,
    tail: m.tail,
  }));

  for (const cue of cues) {
    for (const phrase of cue.phrases) {
      const oblast = matchOblast(phrase) ?? matchOblast(phrase.split(/\s+/)[0] ?? '');
      if (oblast) context.oblast = oblast.key;
    }
  }

  const resolveOne = (phrase: string, tail: string): Resolution | undefined => {
    const bare = phrase.trim();
    // "над містом" points back at the header city.
    if (CITY_WORD.test(bare)) return context.city ?? undefined;
    // "у напрямку Чорного моря", "з акваторії Азовського моря" — coarse, but a real
    // end of a real movement, and the only thing these lines give to draw with.
    /*
     * Enemy launch sites, checked only inside a launch report. Outside one these
     * names are ordinary context ("реактивний на Гірськ з Брянської області" is a
     * drone over Ukraine, not a marker in Russia), and the map is for Ukrainian
     * airspace.
     */
    if (LAUNCH.test(rest)) {
      const site = matchLaunchSite(bare) ?? matchLaunchSite(tail);
      if (site) {
        return {
          name: site.name,
          lat: site.lat,
          lon: site.lon,
          oblast: null,
          kind: 'oblast',
          confidence: 0.5,
        };
      }
    }

    const water = matchWater(tail);
    if (water) {
      return {
        name: water.name,
        lat: water.lat,
        lon: water.lon,
        oblast: null,
        kind: 'oblast',
        confidence: 0.5,
      };
    }
    // "Одеси/Лиманки", "Затоку/Чорноморськ/Одесу" — take the first part that resolves.
    for (const part of bare.split('/')) {
      const hit = context.gazetteer.resolve(part, context.oblast);
      if (hit) return hit;
    }
    return undefined;
  };

  const settlements: { relation: Relation; place: Resolution }[] = [];
  const regions: { relation: Relation; place: Resolution }[] = [];
  const resolvePhrases = (phrases: string[], tail: string): Resolution | undefined => {
    for (const phrase of phrases) {
      const hit = resolveOne(phrase, tail);
      if (hit) return hit;
    }
    return phrases.length === 0 ? resolveOne('', tail) : undefined;
  };

  for (const cue of cues) {
    const resolved = resolvePhrases(cue.phrases, cue.tail);
    if (!resolved) continue;
    (resolved.kind === 'settlement' ? settlements : regions).push({
      relation: cue.relation,
      place: resolved,
    });
  }

  const hits = settlements.length > 0 ? settlements : regions;
  if (hits.length === 0) return [];

  hits.sort((a, b) => RELATION_RANK[b.relation] - RELATION_RANK[a.relation]);

  /*
   * Nothing in the line points forward: every place named is somewhere the target
   * came from, so there is no destination to put a marker on.
   *
   * Only an actual launch report earns the launch marker. "шахед залітає з Одещини"
   * is a transit, not a launch — drawing a launch burst over Odesa claimed a thing
   * that cannot happen there. Both cases still yield an origin with no position, so
   * neither is drawn as a target; only the launch is drawn at all.
   */
  if (hits[0]!.relation === 'from' || (LAUNCH.test(rest) && hits[0]!.relation !== 'towards')) {
    return originOnly(
      hits[0]!.place, type, rest, cleaned,
      LAUNCH.test(rest) && isLaunchOrigin(hits[0]!.place.name, type),
    );
  }

  const destination = hits[0]!;

  // A weaker cue in the same line is where it came from, not a second target.
  const origin = hits.find(
    (h) => h !== destination && h.place.name !== destination.place.name,
  );

  // A region named alongside the destination is a much coarser origin, used only
  // when nothing better is available — see the course resolution below.
  const regionOrigin = origin
    ? undefined
    : regions.find((r) => r.place.name !== destination.place.name);

  const oblast = destination.place.oblast ?? context.oblast;

  /*
   * Cross-oblast movement gives a bearing even when the line names no origin.
   * "Чернігівщина: 1 через Дмитрівку на Сумщину" is a target leaving one region for
   * another, and the region centres describe that direction well enough to draw.
   *
   * Deliberately only across regions: within one oblast the centre is an arbitrary
   * point, and a bearing from it would be noise dressed up as information.
   */
  let inferredOrigin: { lat: number; lon: number } | null =
    regionOrigin ? { lat: regionOrigin.place.lat, lon: regionOrigin.place.lon } : null;

  if (
    !origin &&
    !inferredOrigin &&
    context.oblast &&
    destination.place.oblast &&
    destination.place.oblast !== context.oblast
  ) {
    inferredOrigin = context.gazetteer.centreOf(context.oblast) ?? null;
  }

  if (destination.place.kind === 'settlement' && destination.place.oblast) {
    context.oblast = destination.place.oblast;
  }

  return [
    {
      type,
      rawType: rawTypeOf(rest),
      count: extractCount(rest),
      oblast,
      relation: destination.relation,
      toName: destination.place.name,
      toLat: destination.place.lat,
      toLon: destination.place.lon,
      fromName: origin?.place.name ?? null,
      fromLat: origin?.place.lat ?? null,
      fromLon: origin?.place.lon ?? null,
      /*
       * Course, strongest evidence first:
       *  1. a bearing between two named settlements — the channel said both ends;
       *  2. a course stated in words ("курс південний");
       *  3. a stated approach direction ("з північного сходу"), reciprocated;
       *  4. a bearing from a region centre, which is inferred and coarse.
       *
       * Order matters: an inferred region bearing used to override an explicitly
       * stated compass course, which is exactly backwards.
       */
      courseDeg: resolveCourse(origin, destination, inferredOrigin, rest),
      confidence:
        destination.place.confidence * (type === 'unknown' ? 0.7 : inferred ? 0.85 : 1),
      sourceLine: cleaned,
    },
  ];
}

function resolveCourse(
  origin: { place: Resolution } | undefined,
  destination: { place: Resolution },
  inferredOrigin: { lat: number; lon: number } | null,
  line: string,
): number | null {
  if (origin) {
    return bearing(
      origin.place.lat, origin.place.lon,
      destination.place.lat, destination.place.lon,
    );
  }

  const stated = extractCourse(line) ?? extractApproachCourse(line);
  if (stated !== null) return stated;

  return inferredOrigin
    ? bearing(inferredOrigin.lat, inferredOrigin.lon, destination.place.lat, destination.place.lon)
    : null;
}

const RAW_TYPE_RE =
  /(реактивн[а-яіїєґ]*\s+бпла|бпла|шахед[а-яіїєґ]*|герань[а-яіїєґ]*|каб[а-яіїєґ]*|крилат[а-яіїєґ]*\s+ракет[а-яіїєґ]*|балістик[а-яіїєґ]*|реактивн[а-яіїєґ]*|розвідувальн[а-яіїєґ]*|авіаці[а-яіїєґ]*)/iu;

/** The channel's own wording, kept for the feed and for debugging misclassifications. */
function rawTypeOf(line: string): string | null {
  return RAW_TYPE_RE.exec(line)?.[1]?.trim() ?? null;
}

/** Initial great-circle bearing in degrees, 0 = north. */
export function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const φ1 = lat1 * toRad;
  const φ2 = lat2 * toRad;
  const Δλ = (lon2 - lon1) * toRad;

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);

  return (Math.atan2(y, x) / toRad + 360) % 360;
}

/** Great-circle distance in km. */
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const R = 6371;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
