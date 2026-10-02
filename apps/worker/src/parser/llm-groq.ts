import { config } from '../config.js';
import { logger } from '../logger.js';
import type { Gazetteer } from '@horizont/parser';
import {
  EXTRACTION_JSON_SCHEMA,
  SYSTEM_PROMPT,
  parseExtraction,
  toParsedTargets,
  type LlmExtractor,
} from './llm.js';
import type { ParsedTarget } from '@horizont/parser';

/**
 * Groq provider.
 *
 * Groq exposes an OpenAI-compatible endpoint, so this is a plain POST — no SDK
 * dependency, matching the rest of the project (native fetch, no HTTP client).
 *
 * Two deliberate choices for a free tier:
 *  - `temperature: 0`, because this is extraction, not writing.
 *  - The reply is validated with Zod and a failure returns nothing, so a small model
 *    that returns malformed JSON degrades to "message goes to the feed as text"
 *    rather than corrupting the map.
 */

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const MODELS_ENDPOINT = 'https://api.groq.com/openai/v1/models';

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
  error?: { message?: string; code?: string };
}

export async function listGroqModels(apiKey: string): Promise<string[]> {
  const response = await fetch(MODELS_ENDPOINT, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Groq models request failed: HTTP ${response.status}`);
  const body = (await response.json()) as { data?: { id: string }[] };
  return (body.data ?? []).map((m) => m.id).sort();
}

export function createGroqExtractor(gazetteer: Gazetteer): LlmExtractor {
  const apiKey = config.GROQ_API_KEY;
  if (!apiKey) {
    logger.warn('LLM_PROVIDER=groq but GROQ_API_KEY is unset — running rules-only');
    return { async extract() { return []; } };
  }

  const model = config.GROQ_MODEL;
  logger.info({ model }, 'groq extractor enabled');

  return {
    name: `groq:${model}`,
    async extract(text: string, postedAt: number): Promise<ParsedTarget[] | null> {
      try {
        const response = await fetch(ENDPOINT, {
          method: 'POST',
          signal: AbortSignal.timeout(config.LLM_TIMEOUT_MS),
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            max_tokens: 1024,
            // Structured outputs where the model supports it; the prompt also states
            // the shape, so models that only honour json_object still comply.
            response_format: {
              type: 'json_schema',
              json_schema: { name: 'air_targets', schema: EXTRACTION_JSON_SCHEMA, strict: true },
            },
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: text },
            ],
          }),
        });

        if (response.status === 429) {
          // Free tier throttling is expected, not an incident. The message keeps its
          // rule results and stays pending for a later batch.
          logger.warn({ retryAfter: response.headers.get('retry-after') }, 'groq rate limited');
          return null;
        }

        const body = (await response.json()) as ChatResponse;

        if (!response.ok) {
          logger.warn(
            { status: response.status, reason: body.error?.message, model },
            'groq request failed — check GROQ_MODEL against `npm run llm:check`',
          );
          return null;
        }

        const content = body.choices?.[0]?.message?.content;
        if (!content) {
          logger.warn('groq returned no content');
          return null;
        }

        const extraction = parseExtraction(content);
        if (!extraction) {
          logger.warn({ sample: content.slice(0, 160) }, 'groq reply was not valid extraction JSON');
          return null;
        }

        return toParsedTargets(extraction, text, gazetteer, postedAt);
      } catch (error) {
        // Enrichment failing must never take down ingestion.
        logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'groq extraction failed',
        );
        return null;
      }
    },
  };
}
