import type { Gazetteer, Resolution } from './gazetteer.js';
import { matchOblast } from './oblasts.js';
import { BOUNDARY_LEFT } from './regex.js';
import { classifyType, extractCount, inferBareType, type TargetType } from './targetTypes.js';
import { extractApproachCourse, extractCourse } from './compass.js';
import { matchWater } from './water.js';

/** How a target relates to the place named. */
export type Relation = 'towards' | 'past' | 'through' | 'over' | 'from';

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
  { relation: 'over', source: '[ву]\\s+район[іi]' },
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
const PLACE_FILLER = '(?:(?:центр[ауі]|окол[иі]ц[іь])\\s+|(?:н\\.?\\s?п\\.?|м\\.|с\\.|смт)\\s*)?';
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

/** The phrase a cue points at, or undefined when it points at nothing nameable. */
function placeAfter(text: string): string | undefined {
  const trimmed = text.replace(LEADING_NOISE, '');
  const beyondCompass = trimmed.replace(LEADING_COMPASS, '').replace(LEADING_NOISE, '');
  return PLACE_RE.exec(beyondCompass)?.[1];
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
  towards: 5, through: 4, past: 3, over: 2, from: 1,
};

const EMOJI = /[\p{Extended_Pictographic}️‍]/gu;
const HEADING = /^\s*([А-ЯІЇЄҐ][А-Яа-яІіЇїЄєҐґ'’-]{3,20})\s*[:\-–—]\s*/u;

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
}

/** "над містом", "в напрямку міста" — refers back to the header city. */
const CITY_WORD = /^міст[оаиуе]м?$/iu;

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

  // A line that is only a heading carries no target.
  if (!rest) return [];

  // A short line that is just a settlement name is a header ("⚠ Дніпро"), not a
  // report; remember it so a later "над містом" has something to point at.
  if (!CUE_RE.test(rest)) {
    CUE_RE.lastIndex = 0;
    const asPlace = rest.length <= 30 ? context.gazetteer.resolve(rest, context.oblast) : undefined;
    if (asPlace?.kind === 'settlement') {
      context.city = asPlace;
      if (asPlace.oblast) context.oblast = asPlace.oblast;
      return [];
    }
  }
  CUE_RE.lastIndex = 0;

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
   * `tail` is everything after the cue, kept alongside the capitalised phrase because
   * water names are half lowercase — "Чорного моря" gives up only "Чорного" to a
   * case-sensitive place pattern, which matches no sea.
   */
  CUE_RE.lastIndex = 0;
  const matches = [...rest.matchAll(CUE_RE)]
    .map((m) => {
      const tail = rest.slice(m.index + m[0].length);
      return { cue: m[1]!, phrase: placeAfter(tail), tail };
    })
    .filter((m): m is { cue: string; phrase: string; tail: string } =>
      m.phrase !== undefined || matchWater(m.tail) !== undefined);
  if (matches.length === 0) return bareMention(rest, type, inferred, cleaned, context);

  // Two passes. An oblast named in a line is usually *context* — "БпЛА на
  // Житомирщині, змінив курс на Коростень" is over Zhytomyr oblast heading for
  // Korosten, not heading for the oblast — so oblasts are resolved first and used to
  // disambiguate the settlements, and only stand in as a destination when the line
  // names no settlement at all ("КАБи на Дніпропетровщину").
  const cues = matches.map((m) => ({
    relation: relationFor(m.cue, m.phrase),
    phrase: m.phrase ?? '',
    tail: m.tail,
  }));

  for (const cue of cues) {
    const oblast = matchOblast(cue.phrase) ?? matchOblast(cue.phrase.split(/\s+/)[0] ?? '');
    if (oblast) context.oblast = oblast.key;
  }

  const resolvePhrase = (phrase: string, tail: string): Resolution | undefined => {
    const bare = phrase.trim();
    // "над містом" points back at the header city.
    if (CITY_WORD.test(bare)) return context.city ?? undefined;
    // "у напрямку Чорного моря", "з акваторії Азовського моря" — coarse, but a real
    // end of a real movement, and the only thing these lines give to draw with.
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
  for (const cue of cues) {
    const resolved = resolvePhrase(cue.phrase, cue.tail);
    if (!resolved) continue;
    (resolved.kind === 'settlement' ? settlements : regions).push({
      relation: cue.relation,
      place: resolved,
    });
  }

  const hits = settlements.length > 0 ? settlements : regions;
  if (hits.length === 0) return [];

  hits.sort((a, b) => RELATION_RANK[b.relation] - RELATION_RANK[a.relation]);
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
