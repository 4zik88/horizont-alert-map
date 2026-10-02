/**
 * Unicode-safe word boundaries.
 *
 * JavaScript's `\b` is defined in terms of `\w`, which is ASCII-only, so there is
 * never a boundary between a space and a Cyrillic letter: `/\bповз\b/u` matches
 * nothing in Ukrainian text. This has already caused two silent
 * match-nothing bugs in this project, so every parser pattern is built here.
 */
const LEFT = '(?<![\\p{L}\\p{N}])';
const RIGHT = '(?![\\p{L}\\p{N}])';

/** Wrap a pattern source so it matches only as a whole word. */
export function word(source: string, flags = 'iu'): RegExp {
  return new RegExp(LEFT + '(?:' + source + ')' + RIGHT, flags);
}

/** Same, but anchored only on the left — for matching a stem with any inflection. */
export function stem(source: string, flags = 'iu'): RegExp {
  return new RegExp(LEFT + '(?:' + source + ')', flags);
}

export const BOUNDARY_LEFT = LEFT;
export const BOUNDARY_RIGHT = RIGHT;
