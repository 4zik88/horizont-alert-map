import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { Gazetteer } from './gazetteer.js';
import { matchOblast } from './oblasts.js';
import { bearing } from './rules.js';
import type { ParsedTarget, Relation } from './rules.js';
import type { TargetType } from './targetTypes.js';

/**
 * Claude fallback for messages the rules cannot resolve.
 *
 * The rules handle the ~90% of traffic that follows the channels' house style; this
 * covers free-form phrasing they miss. It is deliberately the exception, not the
 * default — it costs money per message and adds latency to an alerting path.
 */

const TARGET_TYPES = [
  'uav', 'jet_uav', 'cruise', 'ballistic', 'kab', 'aviation', 'recon', 'unknown',
] as const;

const RELATIONS = ['towards', 'past', 'through', 'over', 'from'] as const;

// The response contract from the spec: {type, from, to, time, confidence} per target.
// A list, because one message routinely lists several targets under an oblast heading.
const ExtractionSchema = z.object({
  targets: z.array(
    z.object({
      type: z.enum(TARGET_TYPES),
      count: z.number().int().min(1).max(200),
      from: z.string().describe('Settlement or oblast the target is coming from, Ukrainian nominative, or empty'),
      to: z.string().describe('Settlement or oblast the target is heading to, Ukrainian nominative, or empty'),
      relation: z.enum(RELATIONS),
      oblast: z
        .string()
        .describe('Oblast the target is in, e.g. "Сумщина" or "Сумська", or empty if not stated'),
      time: z.string().describe('Time mentioned in the message, HH:MM, or empty'),
      confidence: z.number().min(0).max(1),
    }),
  ),
});

const SYSTEM = `You extract enemy air target reports from Ukrainian Telegram messages for a civilian air-raid warning tool.

Return one entry per distinct target group mentioned.

Rules:
- "type": uav (БпЛА/шахед/герань), jet_uav (реактивний БпЛА), cruise (крилата ракета), ballistic (балістика), kab (КАБ), aviation (літак/тактична авіація), recon (розвідувальний), unknown.
- "to" is where the target is heading; "from" is where it came from or passed. Use the Ukrainian NOMINATIVE form of the place name (e.g. write "Охтирка", not "Охтирку"; "Липова Долина", not "Липову Долину"). An oblast name such as "Сумщина" is acceptable when no settlement is given.
- A message often lists several targets under a sticky oblast heading; each inherits that oblast.
- "relation": towards (курсом на), past (повз), through (через), over (над), from.
- "oblast": the oblast the target is in, taken from the message's heading if present. This matters: many Ukrainian settlements share a name, and the oblast is what tells them apart.
- "confidence": how sure you are, 0 to 1. Be honest; low confidence is useful.
- Report ONLY enemy targets and their direction. NEVER report air-defence activity, shoot-downs, impacts, or casualties — if the message is only about those, return an empty list.
- If the message is not a target report at all, return an empty list.`;

export interface LlmExtractor {
  /** `postedAt` anchors any clock time the message mentions to a real date. */
  extract(text: string, postedAt: number): Promise<ParsedTarget[]>;
}

/**
 * Resolve a "14:30" mentioned in the message against the time it was posted.
 *
 * Accepted only when it lands within six hours either side of the post, which keeps
 * a misread or hallucinated time from dropping a target hours away in the timeline —
 * where it would either never fire a notification or fade off the map immediately.
 * Anything outside that window falls back to the post time.
 */
export function resolveObservedAt(time: string | undefined, postedAt: number): number {
  const match = /^\s*(\d{1,2})[:.](\d{2})\s*$/.exec(time ?? '');
  if (!match) return postedAt;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return postedAt;

  const candidate = new Date(postedAt);
  candidate.setUTCHours(hours, minutes, 0, 0);

  const SIX_HOURS = 6 * 60 * 60 * 1000;
  for (const shift of [0, -86_400_000, 86_400_000]) {
    const value = candidate.getTime() + shift;
    if (Math.abs(value - postedAt) <= SIX_HOURS) return value;
  }
  return postedAt;
}

/** Returned when no API key is configured: the parser simply keeps its rule results. */
export const DISABLED_EXTRACTOR: LlmExtractor = {
  async extract() {
    return [];
  },
};

export function createExtractor(gazetteer: Gazetteer): LlmExtractor {
  const apiKey = config.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.info('ANTHROPIC_API_KEY not set — LLM fallback disabled, rules only');
    return DISABLED_EXTRACTOR;
  }

  const client = new Anthropic({ apiKey });
  const model = config.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';

  return {
    async extract(text: string, postedAt: number): Promise<ParsedTarget[]> {
      try {
        const response = await client.messages.parse({
          model,
          max_tokens: 2048,
          // Stable prefix, so repeated calls read the system prompt from cache.
          system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: text }],
          output_config: { format: zodOutputFormat(ExtractionSchema) },
        });

        const parsed = response.parsed_output;
        if (!parsed) {
          logger.warn('llm returned no parseable output');
          return [];
        }

        return parsed.targets.flatMap((t) => toParsedTarget(t, text, gazetteer, postedAt));
      } catch (error) {
        // The rules already produced whatever they could; a failed enrichment must
        // never take down ingestion.
        logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'llm extraction failed',
        );
        return [];
      }
    },
  };
}

type RawTarget = z.infer<typeof ExtractionSchema>['targets'][number];

/** Ground the model's place names in the gazetteer — we never trust it for coordinates. */
function toParsedTarget(
  raw: RawTarget,
  sourceLine: string,
  gazetteer: Gazetteer,
  postedAt: number,
): ParsedTarget[] {
  // Use the oblast the model reported to disambiguate, exactly as the rules use the
  // sticky heading — 511 gazetteer names are ambiguous nationally without it.
  const contextOblast = raw.oblast ? (matchOblast(raw.oblast)?.key ?? null) : null;

  const to = raw.to ? gazetteer.resolve(raw.to, contextOblast) : undefined;
  if (!to) return [];

  const from = raw.from ? gazetteer.resolve(raw.from, contextOblast) : undefined;

  return [
    {
      type: raw.type as TargetType,
      rawType: null,
      count: raw.count,
      oblast: to.oblast ?? contextOblast,
      relation: raw.relation as Relation,
      toName: to.name,
      toLat: to.lat,
      toLon: to.lon,
      fromName: from?.name ?? null,
      fromLat: from?.lat ?? null,
      fromLon: from?.lon ?? null,
      courseDeg: from ? bearing(from.lat, from.lon, to.lat, to.lon) : null,
      // Combine the model's own confidence with how sure the gazetteer match is.
      confidence: raw.confidence * to.confidence,
      observedAt: resolveObservedAt(raw.time, postedAt),
      sourceLine,
    },
  ];
}
