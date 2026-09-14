
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

/*
 * The compass word has to be bound to the course word, not merely present in the
 * same line.
 *
 * "Ударні БпЛА з півночі Сумщини на північ Чернігівщини курс західний" names three
 * directions: two are locations and only the last is the heading. Testing the line
 * as a whole returned north — the first compass word in table order — for a target
 * travelling west. These patterns read the word next to the course marker instead,
 * which is the only one that means a heading.
 *
 * `рух` rather than `рухається`: the plural "рухаються західним курсом" is at least
 * as common in these channels, and the singular-only stem matched none of them.
 */
const BOUND_TO_COURSE = (point: string): RegExp[] => [
  // "курс північний", "курсом на північ", "курс - південно-східний"
  new RegExp(`курс(?:ом)?\\s*[-–—:]?\\s*(?:на\\s+)?(?:${point})`, 'iu'),
  // "західним курсом", "північно-східним курсом"
  new RegExp(`(?:${point})[а-яіїєґ]*\\s+курс(?:ом)?`, 'iu'),
  // "рухаються у західному напрямку", "прямує на північ"
  new RegExp(
    `(?:рух|прямує|іде|йде|заходят|летят|летить|напрям)[а-яіїєґ]*\\s+` +
      `(?:[ву]\\s+|на\\s+)?(?:${point})`,
    'iu',
  ),
  // "у західному напрямку"
  new RegExp(`[ву]\\s+(?:${point})[а-яіїєґ]*\\s+напрям`, 'iu'),
];

/**
 * Extract a heading in degrees, or null.
 *
 * Requires the compass word to sit next to a course word: plain "на півночі
 * Чернігівщини" is a *location*, not a heading, and reading it as one would point
 * the arrow the wrong way.
 */
export function extractCourse(line: string): number | null {
  for (const point of POINTS) {
    for (const pattern of BOUND_TO_COURSE(point.source)) {
      if (pattern.test(line)) return point.deg;
    }
  }
  return null;
}

/**
 * A stated *approach* direction — "БпЛА в напрямку Охтирки з північного сходу".
 *
 * This says where the target came from, so the heading is the reciprocal. It is a
 * separate rule from `extractCourse` because the same compass word means the
 * opposite thing depending on whether it follows "курс" or "з".
 */
/*
 * The compound forms are written every way: "з північного сходу", "з
 * північного-сходу", "з північно-східного напрямку". Matching only "північно" missed
 * the inflected "північного", which is the more common spelling of the two.
 */
const FROM_DIRECTION = /(?<![\p{L}])(?:з|із|зі)\s+(північн[а-яіїєґ]*[- ]?сход|південн[а-яіїєґ]*[- ]?сход|південн[а-яіїєґ]*[- ]?заход|північн[а-яіїєґ]*[- ]?заход|північно[- ]?схід|південно[- ]?схід|південно[- ]?захід|північно[- ]?захід|північн|південн|східн|західн|півноч|півдн|сход|заход)/iu;

const FROM_DEGREES: { deg: number; test: RegExp }[] = [
  { deg: 45, test: /північн[а-яіїєґ]*[- ]?с(?:хід|ход)/iu },
  { deg: 135, test: /південн[а-яіїєґ]*[- ]?с(?:хід|ход)/iu },
  { deg: 225, test: /південн[а-яіїєґ]*[- ]?з(?:ахід|аход)/iu },
  { deg: 315, test: /північн[а-яіїєґ]*[- ]?з(?:ахід|аход)/iu },
  { deg: 0, test: /північн|півноч/iu },
  { deg: 90, test: /східн|сход/iu },
  { deg: 180, test: /південн|півдн/iu },
  { deg: 270, test: /західн|заход/iu },
];

export function extractApproachCourse(line: string): number | null {
  const match = FROM_DIRECTION.exec(line);
  if (!match) return null;

  const phrase = match[1]!;
  for (const entry of FROM_DEGREES) {
    // Coming *from* the north-east means travelling south-west.
    if (entry.test.test(phrase)) return (entry.deg + 180) % 360;
  }
  return null;
}
