/**
 * Hard product constraint: never display or act on anything about air-defence work or
 * impacts — only enemy targets and their direction.
 *
 * The source channels do not publish air-defence positions, but @kpszsu does post
 * daily summaries carrying shoot-down and impact counts (e.g. kpszsu/78115:
 * "збито/подавлено 310 БпЛА … Зафіксовано влучання 10 ударних БпЛА"). Those are
 * flagged here at ingest so the step-2 parser skips them and the step-4 feed can never
 * render them.
 *
 * The raw text is still stored: the flag is advisory and deliberately over-broad, so a
 * false positive costs one skipped summary rather than silently destroying a
 * legitimate report.
 */

/**
 * Word stems, matched at a word start.
 *
 * NOTE: `\b` is useless here. JavaScript defines it in terms of `\w`, which is ASCII
 * only, so there is no word boundary between a space and a Cyrillic letter and every
 * `\b`-anchored pattern would silently never fire. The lookbehind below uses Unicode
 * property escapes instead.
 */
const STEMS = [
  'збит',        // збито / збита / збиті / збиття
  'збива',       // збивати / збивають: "наші намагаються збивати"
  'збили',
  'подавл',      // подавлено
  'влучан',      // влучання
  'приліт', 'прильот', 'прилет',
  'уламк',       // уламки
  'наслідк',     // наслідки
  'пошкодж',     // пошкоджено
  'загинул', 'постражда', 'поранен',
  'детонац',
];

const STEM_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${STEMS.join('|')})`, 'iu');

/** Multi-word phrases about air-defence activity, which stems alone would miss. */
const PHRASE_RE = /(?<![\p{L}\p{N}])(?:ППО\s+прац|робот[уаи]\s+ППО|сил[иа]\s+ППО|працює\s+ППО|відпрацюв)/iu;

export function isSensitive(text: string): boolean {
  if (text.length === 0) return false;
  return STEM_RE.test(text) || PHRASE_RE.test(text);
}
