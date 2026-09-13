import { stem, word } from './regex.js';

/**
 * Target classes we track. Only enemy targets and their direction — never
 * air-defence activity or impacts, which are filtered upstream by `sensitive.ts`.
 */
export type TargetType =
  | 'uav'        // БпЛА / шахед / герань
  | 'jet_uav'    // реактивний БпЛА — materially faster, so worth its own class
  | 'cruise'     // крилата ракета, Калібр, Х-101
  | 'ballistic'  // балістика, Іскандер-М
  | 'kab'        // керована авіабомба
  | 'aviation'   // тактична авіація, борт
  | 'recon'      // розвідувальний БпЛА
  | 'unknown';

/**
 * Ordered — the first match wins, so more specific patterns must come first.
 * "Реактивний БпЛА" has to classify as `jet_uav`, not `uav`, and a jet UAV covers
 * ground several times faster, which changes every distance/ETA estimate downstream.
 */
const RULES: { type: TargetType; re: RegExp }[] = [
  { type: 'ballistic', re: stem('балістик|балістичн|іскандер-м|кн-23') },
  // "Швидкісна ціль" and a bare "ракети" are announced without naming the weapon.
  // They are missile-class, so cruise speed is the right assumption for ETA — a
  // genuinely ballistic launch is always called "балістика" and is matched above.
  { type: 'cruise', re: stem('крилат|калібр|х-101|х-555|х-59|х-31|іскандер-к|бандероль|дань-т|швидкісн[а-яіїєґ]*\\s+ціль|ракет') },
  { type: 'kab', re: word('каб[а-яіїєґ]*|кабів|керован[а-яіїєґ]*\\s+авіабомб[а-яіїєґ]*|фаб-\\d+') },
  { type: 'recon', re: stem('розвід') },
  { type: 'jet_uav', re: stem('реактивн') },
  { type: 'uav', re: stem('бпла|безпілотник|шахед|герань|shahed|geran|мопед') },
  { type: 'aviation', re: stem('тактичн[а-яіїєґ]*\\s+авіаці|авіаці|літак|борт[а-яіїєґ]*|міг-\\d+|ту-\\d+|су-\\d+') },
];

/**
 * Classify a line. `fallback` carries the type from the message's heading or the
 * previous line, because channels routinely drop it once established — a bare
 * "1 на Корець" under a "БпЛА" block still means a UAV.
 */
export function classifyType(text: string, fallback: TargetType = 'unknown'): TargetType {
  for (const rule of RULES) {
    if (rule.re.test(text)) return rule.type;
  }
  return fallback;
}

/** Rough cruise speed in km/h, used for ETA and for ageing markers off the map. */
export const TYPE_SPEED_KMH: Record<TargetType, number> = {
  uav: 180,
  jet_uav: 600,
  cruise: 800,
  ballistic: 3000,
  kab: 700,
  aviation: 800,
  recon: 150,
  unknown: 200,
};

/**
 * Anchored at the start on purpose. An unanchored search reads the "101" out of
 * "Х-101" and the "00" out of "Станом на 18.00" as target counts; channels always
 * put a real count first ("3 БпЛА курсом на Сосницю", "2х БпЛА").
 */
const COUNT_RE = /^(\d{1,3})\s*(?:х|x|шт\.?)?\s/u;

/** Leading count, as in "3 БпЛА курсом на Сосницю" or "2х БпЛА". Defaults to 1. */
export function extractCount(text: string): number {
  const match = COUNT_RE.exec(text.trim());
  if (!match) return 1;
  const value = Number.parseInt(match[1]!, 10);
  // Guard against a year or a calibre being read as a count.
  return value >= 1 && value <= 200 ? value : 1;
}
