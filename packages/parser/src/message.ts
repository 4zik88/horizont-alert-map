import type { Gazetteer } from './gazetteer.js';
import { isFundraising, stripBoilerplate } from './clean.js';
import { parseLine, type ParseContext, type ParsedTarget } from './rules.js';
import { classifyType } from './targetTypes.js';
import { stem, word } from './regex.js';
import { isSensitive } from './sensitive.js';
import { resolveObservedAt, statedTime } from './time.js';

export type ParseState = 'parsed' | 'unparsed';

export interface ParseResult {
  targets: ParsedTarget[];
  state: ParseState;
  /** True when the rules are not trusted and the LLM should get a look. */
  needsLlm: boolean;
}

/** Does this look like a target report at all, even if nothing resolved? */
const LOOKS_LIKE_REPORT = stem(
  'бпла|шахед|герань|ракет|балістик|каб|авіаці|реактивн|курс|напрямку|повз|через',
);

const LOW_CONFIDENCE = 0.5;

/*
 * A line that reports a target as gone: "мінус по шахеду на Барабой", "На Санжейку
 * мінус", "На Тернопільщині - зник", "Не фіксується більше". The place in it is where
 * the target *was*, so reading it as a live report put a fresh marker on a drone that
 * no longer exists. The line is dropped; other lines of the same message still count
 * ("по цьому мінус / але є ще один в морі, курс Чорноморськ").
 */
const LOST = word('мінус|зник|зникла|зникли|зникло|не\\s+фіксу[єю]ться');

/*
 * A line that stands a threat down: "Одещина відбій тривоги", "локаційно чисто",
 * "Бандеролі без фіксації". Nothing on it is live, and it names a region in the same
 * breath, which the model was being invited to read back as a target.
 */
const STAND_DOWN = stem('відбій|чисто|без\\s+фіксац|без\\s+загроз');

/*
 * The model returns place *names*, which only count once the gazetteer grounds them.
 * Text with no capitalised word has no name to ground, so a call can only cost money
 * or invent something: "🔴✈️по шахедах загроза є, все без змін".
 */
const CANDIDATE_NAME = /(?<![\p{L}\p{N}])[А-ЯІЇЄҐ][а-яіїєґ'’]{2,}/u;

/**
 * Parse a whole message into targets.
 *
 * Per the product rule, anything the rules cannot resolve is *not* forced into a
 * marker — it stays `unparsed` and the feed shows it as plain text. A wrong pin on
 * a map is worse than no pin.
 */
export function parseMessage(
  text: string,
  gazetteer: Gazetteer,
  /** Epoch ms the message was posted; anchors a stated "о 15:20" to a real instant. */
  postedAt?: number,
): ParseResult {
  const cleaned = stripBoilerplate(text);
  if (!cleaned) return { targets: [], state: 'unparsed', needsLlm: false };

  /*
   * A post asking for donations is not a report, however it is worded — and one of
   * them described what the channel does ("сповістити про кожну ціль ... з Одеси")
   * in language close enough to a warning to produce a target on Odesa with a real
   * position. `needsLlm` stays false: there is nothing here for the LLM to recover.
   */
  if (isFundraising(cleaned)) return { targets: [], state: 'unparsed', needsLlm: false };

  // The worker already skips these at ingest. Refusing here as well means no other
  // caller can turn a shoot-down summary into map markers by forgetting to check.
  if (isSensitive(cleaned)) return { targets: [], state: 'unparsed', needsLlm: false };

  const context: ParseContext = {
    gazetteer,
    oblast: null,
    type: classifyType(cleaned),
    city: null,
    launch: false,
  };
  const targets: ParsedTarget[] = [];

  const live = cleaned.split('\n').filter((line) => !LOST.test(line) && !STAND_DOWN.test(line));
  for (const line of live) {
    targets.push(...parseLine(line, context));
  }

  // Judged on the live lines only, so "мінус по шахеду на Барабой" is not handed to
  // the model to re-read as a report.
  const stated = postedAt === undefined ? undefined : statedTime(cleaned);
  if (stated && postedAt !== undefined) {
    const at = resolveObservedAt(stated, postedAt);
    for (const t of targets) t.observedAt ??= at;
  }

  const liveText = live.join('\n');
  const looksLikeReport = LOOKS_LIKE_REPORT.test(liveText) && CANDIDATE_NAME.test(liveText);
  const lowConfidence = targets.some((t) => t.confidence < LOW_CONFIDENCE);

  return {
    targets,
    state: targets.length > 0 ? 'parsed' : 'unparsed',
    needsLlm: (targets.length === 0 && looksLikeReport) || lowConfidence,
  };
}
