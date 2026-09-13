import type { Gazetteer } from './gazetteer.js';
import { stripBoilerplate } from './clean.js';
import { parseLine, type ParseContext, type ParsedTarget } from './rules.js';
import { classifyType } from './targetTypes.js';
import { stem } from './regex.js';

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

/**
 * Parse a whole message into targets.
 *
 * Per the product rule, anything the rules cannot resolve is *not* forced into a
 * marker — it stays `unparsed` and the feed shows it as plain text. A wrong pin on
 * a map is worse than no pin.
 */
export function parseMessage(text: string, gazetteer: Gazetteer): ParseResult {
  const cleaned = stripBoilerplate(text);
  if (!cleaned) return { targets: [], state: 'unparsed', needsLlm: false };

  const context: ParseContext = {
    gazetteer,
    oblast: null,
    type: classifyType(cleaned),
    city: null,
  };
  const targets: ParsedTarget[] = [];

  for (const line of cleaned.split('\n')) {
    targets.push(...parseLine(line, context));
  }

  const looksLikeReport = LOOKS_LIKE_REPORT.test(cleaned);
  const lowConfidence = targets.some((t) => t.confidence < LOW_CONFIDENCE);

  return {
    targets,
    state: targets.length > 0 ? 'parsed' : 'unparsed',
    needsLlm: (targets.length === 0 && looksLikeReport) || lowConfidence,
  };
}
