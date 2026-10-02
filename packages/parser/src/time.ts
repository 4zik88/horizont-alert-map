/**
 * Clock times written in messages, turned into instants.
 *
 * The channels write Kyiv wall-clock time. Reading "14:30" as UTC put every stated
 * time three hours early in summer (two in winter) — and the sanity window below was
 * wide enough to accept the wrong answer, so nothing ever flagged it.
 */

const HOUR = 3_600_000;

/** Kyiv's UTC offset at an instant, in ms: +3 h in summer, +2 h in winter. */
export function kyivOffsetMs(at: number): number {
  const zone = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Kyiv',
    timeZoneName: 'shortOffset',
  })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName')?.value;
  const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(zone ?? '');
  if (!match) return 2 * HOUR;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * HOUR + Number(match[3] ?? 0) * 60_000);
}

/**
 * Resolve a Kyiv "14:30" mentioned in a message against the time it was posted.
 *
 * Accepted only within six hours either side of the post, so a misread or invented
 * time cannot drop a target hours away in the timeline — where it would never fire a
 * notification or would fade off the map immediately.
 */
export function resolveObservedAt(time: string | undefined, postedAt: number): number {
  const match = /^\s*(\d{1,2})[:.](\d{2})\s*$/.exec(time ?? '');
  if (!match) return postedAt;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return postedAt;

  // Work in "Kyiv wall clock as if it were UTC", then convert back.
  const offset = kyivOffsetMs(postedAt);
  const wall = new Date(postedAt + offset);
  wall.setUTCHours(hours, minutes, 0, 0);

  for (const shift of [0, -24 * HOUR, 24 * HOUR]) {
    const value = wall.getTime() + shift - offset;
    if (Math.abs(value - postedAt) <= 6 * HOUR) return value;
  }
  return postedAt;
}

/*
 * Only times that say when something *was seen*: "О 15:20 пуски шахедів",
 * "[13.09.2026 16:25] Пуск …". Not "якщо в бік Одещини +- 23:50", which is a forecast
 * arrival — stamping that as the observation would move the target into the future.
 */
const STATED_TIME = new RegExp(
  [
    '(?<![\\p{L}\\p{N}])(?:о|об)\\s+(\\d{1,2}[:.]\\d{2})(?!\\d)',
    '\\[\\d{2}\\.\\d{2}\\.\\d{4}\\s+(\\d{1,2}:\\d{2})\\]',
  ].join('|'),
  'iu',
);

/** "орієнтовно о 23:50", "+- 23:50", "до 23:50": an estimate, not an observation. */
const ESTIMATE_BEFORE = /(?:орієнтовн\p{L}*|приблизн\p{L}*|\+-|±|~|(?<!\p{L})до)\s*$/iu;

/** The observation time a message states, as "HH:MM", if it states one. */
export function statedTime(text: string): string | undefined {
  for (const match of text.matchAll(new RegExp(STATED_TIME.source, 'giu'))) {
    if (ESTIMATE_BEFORE.test(text.slice(Math.max(0, match.index - 16), match.index))) continue;
    return match[1] ?? match[2];
  }
  return undefined;
}
