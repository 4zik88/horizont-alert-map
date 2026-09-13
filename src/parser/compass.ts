import { stem } from './regex.js';

/**
 * Compass headings.
 *
 * Channels often give a course with no destination at all — "Ударні БпЛА на півдні
 * Сумщини, курс західний" — which still says which way the target is travelling.
 * Without this the line yields a position and no heading, and the map cannot draw
 * the arrow that makes a target legible.
 */
const POINTS: { deg: number; source: string }[] = [
  // Compound directions first: "північно-східний" must not match as "північ".
  { deg: 45, source: 'північно[- ]?схід[а-яіїєґ]*' },
  { deg: 135, source: 'південно[- ]?схід[а-яіїєґ]*' },
  { deg: 225, source: 'південно[- ]?захід[а-яіїєґ]*' },
  { deg: 315, source: 'північно[- ]?захід[а-яіїєґ]*' },
  { deg: 0, source: 'північн[а-яіїєґ]*|північ' },
  { deg: 90, source: 'східн[а-яіїєґ]*|схід' },
  { deg: 180, source: 'південн[а-яіїєґ]*|південь' },
  { deg: 270, source: 'західн[а-яіїєґ]*|захід' },
];

/** Only read a direction when it is actually presented as a course. */
const COURSE_CONTEXT = stem('курс|напрям|рухається|прямує|іде|йде|заходят|летят|летить');

/**
 * Extract a heading in degrees, or null.
 *
 * Requires a course word nearby: plain "на півночі Чернігівщини" is a *location*,
 * not a heading, and reading it as one would point the arrow the wrong way.
 */
export function extractCourse(line: string): number | null {
  if (!COURSE_CONTEXT.test(line)) return null;

  for (const point of POINTS) {
    if (stem(point.source).test(line)) return point.deg;
  }
  return null;
}
