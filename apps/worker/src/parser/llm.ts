import { config } from '../config.js';
import { logger } from '../logger.js';
import { DISABLED_EXTRACTOR, type Gazetteer, type LlmExtractor } from '@horizont/parser';

// The provider-agnostic contract lives in @horizont/parser; re-exported for callers here.
export {
  DISABLED_EXTRACTOR,
  EXTRACTION_JSON_SCHEMA,
  ExtractionSchema,
  SYSTEM_PROMPT,
  parseExtraction,
  resolveObservedAt,
  toParsedTargets,
  type Extraction,
  type LlmExtractor,
  type RawTarget,
} from '@horizont/parser';

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
