import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { Gazetteer } from './gazetteer.js';
import {
  ExtractionSchema,
  SYSTEM_PROMPT,
  toParsedTargets,
  type LlmExtractor,
} from './llm.js';
import type { ParsedTarget } from './rules.js';

/** Anthropic provider. Kept as a drop-in alternative to Groq via LLM_PROVIDER. */
export function createAnthropicExtractor(gazetteer: Gazetteer): LlmExtractor {
  const apiKey = config.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.warn('LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is unset — running rules-only');
    return { async extract() { return []; } };
  }

  const client = new Anthropic({ apiKey });
  const model = config.ANTHROPIC_MODEL;
  logger.info({ model }, 'anthropic extractor enabled');

  return {
    async extract(text: string, postedAt: number): Promise<ParsedTarget[]> {
      try {
        const response = await client.messages.parse({
          model,
          max_tokens: 1024,
          // Stable prefix, so repeated calls read the system prompt from cache.
          system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: text }],
          output_config: { format: zodOutputFormat(ExtractionSchema) },
        });

        const parsed = response.parsed_output;
        if (!parsed) {
          logger.warn('anthropic returned no parseable output');
          return [];
        }

        return toParsedTargets(parsed, text, gazetteer, postedAt);
      } catch (error) {
        logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'anthropic extraction failed',
        );
        return [];
      }
    },
  };
}
