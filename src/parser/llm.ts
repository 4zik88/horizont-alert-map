import { z } from 'zod';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { Gazetteer } from './gazetteer.js';
import { matchOblast } from './oblasts.js';
import { bearing } from './rules.js';
import type { ParsedTarget, Relation } from './rules.js';
import type { TargetType } from './targetTypes.js';

/**
 * Provider-agnostic fallback for messages the rules cannot resolve.
 *
 * The rules handle the traffic that follows the channels' house style; this covers
 * free-form phrasing they miss. It is deliberately the exception, not the default —
 * it adds latency to an alerting path and, on a paid provider, cost per message.
 *
 * The model is never trusted for coordinates. It returns place *names*, which are
 * resolved through the same gazetteer as the rules, so a model that invents a town
 * produces nothing rather than a wrong pin. That guard is what makes a small free
 * model a reasonable choice here.
 */

const TARGET_TYPES = [
  'uav', 'jet_uav', 'cruise', 'ballistic', 'kab', 'aviation', 'recon', 'unknown',
] as const;

const RELATIONS = ['towards', 'past', 'through', 'over', 'from'] as const;

/** The response contract: {type, from, to, time, confidence} per target, as a list. */
export const ExtractionSchema = z.object({
  targets: z.array(
    z.object({
      type: z.enum(TARGET_TYPES),
      count: z.number().int().min(1).max(200).default(1),
      from: z.string().default(''),
      to: z.string().default(''),
      relation: z.enum(RELATIONS).default('towards'),
      oblast: z.string().default(''),
      time: z.string().default(''),
      confidence: z.number().min(0).max(1).default(0.5),
    }),
  ),
});

export type Extraction = z.infer<typeof ExtractionSchema>;
export type RawTarget = Extraction['targets'][number];

/** JSON Schema mirror of the above, for providers that accept one. */
export const EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    targets: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: [...TARGET_TYPES] },
          count: { type: 'integer' },
          from: { type: 'string' },
          to: { type: 'string' },
          relation: { type: 'string', enum: [...RELATIONS] },
          oblast: { type: 'string' },
          time: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['type', 'count', 'from', 'to', 'relation', 'oblast', 'time', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['targets'],
  additionalProperties: false,
} as const;

export const SYSTEM_PROMPT = `You extract enemy air target reports from Ukrainian Telegram messages for a civilian air-raid warning tool.

Reply with JSON only, in exactly this shape:
{"targets":[{"type":"uav","count":1,"from":"","to":"Охтирка","relation":"towards","oblast":"Сумська","time":"","confidence":0.9}]}

Return one entry per distinct target group mentioned. Rules:
- "type": one of uav (БпЛА/шахед/герань), jet_uav (реактивний БпЛА), cruise (крилата ракета/швидкісна ціль), ballistic (балістика), kab (КАБ), aviation (літак/тактична авіація), recon (розвідувальний), unknown.
- "to" is where the target is heading; "from" is where it came from or passed. Use the Ukrainian NOMINATIVE form of the place name: write "Охтирка" not "Охтирку", "Липова Долина" not "Липову Долину", "Кривий Ріг" not "Кривого Рогу". Leave it "" if not stated.
- "oblast": the oblast the target is in, from the message heading if present. This matters — many Ukrainian settlements share a name and the oblast is what tells them apart.
- "relation": towards (курсом на), past (повз), through (через), over (над/в районі), from.
- "time": a clock time stated in the message as HH:MM, else "".
- "confidence": 0 to 1, honestly. Low confidence is useful.
- Report ONLY enemy targets and their direction. NEVER report air-defence activity, shoot-downs, impacts, or casualties. If the message is only about those, return {"targets":[]}.
- If it is not a target report at all, return {"targets":[]}.`;

export interface LlmExtractor {
  /** `postedAt` anchors any clock time the message mentions to a real date. */
  extract(text: string, postedAt: number): Promise<ParsedTarget[]>;
}

/** Used when no provider is configured: the parser keeps its rule results. */
export const DISABLED_EXTRACTOR: LlmExtractor = {
  async extract() {
    return [];
  },
};

/**
 * Resolve a "14:30" mentioned in the message against the time it was posted.
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

  const candidate = new Date(postedAt);
  candidate.setUTCHours(hours, minutes, 0, 0);

  const SIX_HOURS = 6 * 60 * 60 * 1000;
  for (const shift of [0, -86_400_000, 86_400_000]) {
    const value = candidate.getTime() + shift;
    if (Math.abs(value - postedAt) <= SIX_HOURS) return value;
  }
  return postedAt;
}

/** Ground the model's place names in the gazetteer. Never trust it for coordinates. */
export function toParsedTargets(
  extraction: Extraction,
  sourceText: string,
  gazetteer: Gazetteer,
  postedAt: number,
): ParsedTarget[] {
  return extraction.targets.flatMap((raw) => {
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
        confidence: raw.confidence * to.confidence,
        observedAt: resolveObservedAt(raw.time, postedAt),
        sourceLine: sourceText,
      },
    ];
  });
}

/**
 * Parse and validate a provider's raw reply.
 *
 * Small models wrap JSON in prose or code fences often enough that it is worth
 * recovering the object rather than discarding the answer.
 */
export function parseExtraction(raw: string): Extraction | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const candidate = fenced?.[1] ?? raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;

  try {
    const parsed = ExtractionSchema.safeParse(JSON.parse(candidate.slice(start, end + 1)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Chooses a provider from the environment. Explicit LLM_PROVIDER wins. */
export async function createExtractor(gazetteer: Gazetteer): Promise<LlmExtractor> {
  const explicit = config.LLM_PROVIDER;
  const provider =
    explicit !== 'auto'
      ? explicit
      : config.GROQ_API_KEY ? 'groq'
      : config.ANTHROPIC_API_KEY ? 'anthropic'
      : 'none';

  if (provider === 'groq') {
    const { createGroqExtractor } = await import('./llm-groq.js');
    return createGroqExtractor(gazetteer);
  }
  if (provider === 'anthropic') {
    const { createAnthropicExtractor } = await import('./llm-anthropic.js');
    return createAnthropicExtractor(gazetteer);
  }

  logger.info('no LLM provider configured — parser runs rules-only');
  return DISABLED_EXTRACTOR;
}
