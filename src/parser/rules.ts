import type { Gazetteer, Resolution } from './gazetteer.js';
import { matchOblast } from './oblasts.js';
import { BOUNDARY_LEFT } from './regex.js';
import { classifyType, extractCount, type TargetType } from './targetTypes.js';
import { extractCourse } from './compass.js';

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
  { relation: 'from', source: 'з\\s+боку' },
  { relation: 'from', source: 'зі\\s+сторони' },
  { relation: 'past', source: 'повз' },
  { relation: 'through', source: 'через' },
  { relation: 'over', source: 'над' },
  // "в р-ні Павлограду", "поблизу Ніжина", "північніше Нікополя" — all say where the
  // target currently is rather than where it is going.
  { relation: 'over', source: '[ву]\\s+р-?н[іi]?\\.?(?:\\s+н\\.?п\\.?)?' },
  { relation: 'over', source: '[ву]\\s+район[іi]' },
  { relation: 'over', source: 'поблизу|біля|неподалік' },
  { relation: 'over', source: '(?:північн|південн|західн|східн)[а-яіїєґ]*іше' },
  // "на півдні Сумщини" locates the target inside a region rather than sending it
  // there; the heading then comes from a stated compass course.
  { relation: 'over', source: 'на\\s+(?:півноч[іi]|півдн[іi]|сход[іi]|заход[іi])' },
  { relation: 'towards', source: 'на' },
];

// One alternation with a named-ish structure: cue, then the capitalised phrase after it.
const PLACE = "([А-ЯІЇЄҐA-Z][^\\s,.;:!?()]*(?:\\s+[А-ЯІЇЄҐ][^\\s,.;:!?()]*){0,2})";
const CUE_RE = new RegExp(
  `${BOUNDARY_LEFT}(${RELATION_CUES.map((c) => c.source).join('|')})\\s+${PLACE}`,
  'giu',
);

function relationFor(cue: string): Relation {
  const normalised = cue.toLowerCase().replace(/\s+/g, ' ');
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

  const type = classifyType(rest, context.type);
  if (type !== 'unknown') context.type = type;

  const matches = [...rest.matchAll(CUE_RE)];
  if (matches.length === 0) return [];

  // Two passes. An oblast named in a line is usually *context* — "БпЛА на
  // Житомирщині, змінив курс на Коростень" is over Zhytomyr oblast heading for
  // Korosten, not heading for the oblast — so oblasts are resolved first and used to
  // disambiguate the settlements, and only stand in as a destination when the line
  // names no settlement at all ("КАБи на Дніпропетровщину").
  const cues = matches.map((m) => ({ relation: relationFor(m[1]!), phrase: m[2]! }));

  for (const cue of cues) {
    const oblast = matchOblast(cue.phrase) ?? matchOblast(cue.phrase.split(/\s+/)[0] ?? '');
    if (oblast) context.oblast = oblast.key;
  }

  const resolvePhrase = (phrase: string): Resolution | undefined => {
    const bare = phrase.trim();
    // "над містом" points back at the header city.
    if (CITY_WORD.test(bare)) return context.city ?? undefined;
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
    const resolved = resolvePhrase(cue.phrase);
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
  const origin = hits.find((h) => h !== destination && h.place.name !== destination.place.name);

  const oblast = destination.place.oblast ?? context.oblast;
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
      // A bearing between two named places is the best signal; a stated compass
      // course ("курс західний") is the fallback when only one place is named.
      courseDeg: origin
        ? bearing(origin.place.lat, origin.place.lon, destination.place.lat, destination.place.lon)
        : extractCourse(rest),
      confidence: destination.place.confidence * (type === 'unknown' ? 0.7 : 1),
      sourceLine: cleaned,
    },
  ];
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
