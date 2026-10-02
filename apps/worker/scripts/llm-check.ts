/**
 * Verifies the LLM fallback end to end:
 *   npm run llm:check
 *
 * Lists the models your key can actually use (Groq rotates its catalogue, so a model
 * name that worked last month may 404 today), then runs the extractor over real
 * unparsed messages from your own database and shows what it would have added.
 *
 * Read-only: it writes nothing to the database.
 */
import { connect } from '@horizont/db';
import { config, redactedConfig } from '../src/config.js';
import { loadGazetteer } from '../src/db/gazetteer.js';
import { createExtractor } from '../src/parser/llm.js';
import { listGroqModels } from '../src/parser/llm-groq.js';
import { parseMessage } from '@horizont/parser';

const SAMPLE_SIZE = Number.parseInt(process.env['SAMPLE'] ?? '8', 10);

async function main(): Promise<void> {
  const cfg = redactedConfig();
  console.log(`LLM_PROVIDER = ${cfg['LLM_PROVIDER']}`);
  console.log(`GROQ_API_KEY = ${cfg['GROQ_API_KEY']}   GROQ_MODEL = ${cfg['GROQ_MODEL']}`);
  console.log(`ANTHROPIC_API_KEY = ${cfg['ANTHROPIC_API_KEY']}\n`);

  if (config.GROQ_API_KEY) {
    try {
      const models = await listGroqModels(config.GROQ_API_KEY);
      console.log(`models available to this key (${models.length}):`);
      for (const m of models) {
        console.log(`  ${m === config.GROQ_MODEL ? '->' : '  '} ${m}`);
      }
      if (!models.includes(config.GROQ_MODEL)) {
        console.log(`\n!! GROQ_MODEL="${config.GROQ_MODEL}" is NOT in that list.`);
        console.log(`   Set GROQ_MODEL in .env to one of the names above.\n`);
      } else {
        console.log('');
      }
    } catch (error) {
      console.log(`could not list models: ${error instanceof Error ? error.message : error}\n`);
    }
  }

  // Read-only: connect without migrating, and only ever SELECT.
  const db = connect(config.DATABASE_URL);
  const { rows: [toponyms] } = await db.query<{ c: number }>('SELECT COUNT(*) AS c FROM toponyms');
  if (toponyms!.c === 0) {
    console.error('Gazetteer is empty — run `npm run build:toponyms` first.');
    process.exit(1);
  }

  const gazetteer = await loadGazetteer(db);
  const extractor = await createExtractor(gazetteer);

  // Real messages the rules could not resolve — exactly what the fallback exists for.
  const { rows: all } = await db.query<{ text: string; posted_at: number }>(
    `SELECT text, posted_at FROM messages WHERE is_sensitive = 0 AND text <> '' ORDER BY id`,
  );
  await db.close();
  const candidates = all
    .filter((m) => parseMessage(m.text, gazetteer).needsLlm)
    .slice(0, SAMPLE_SIZE);

  console.log(`running the extractor over ${candidates.length} unresolved messages\n`);

  let recovered = 0;
  const started = Date.now();

  for (const message of candidates) {
    const targets = await extractor.extract(message.text, message.posted_at);
    console.log(`"${message.text.replace(/\n/g, ' | ').slice(0, 76)}"`);
    if (targets === null) {
      console.log('   -> no usable answer (failed, throttled or unparseable)');
    } else if (targets.length === 0) {
      console.log('   -> nothing (stays in the feed as plain text)');
    } else {
      recovered++;
      for (const t of targets) {
        console.log(
          `   -> ${t.type} ${t.relation} ${t.fromName ?? '-'} => ${t.toName} ` +
            `conf=${t.confidence.toFixed(2)}`,
        );
      }
    }
  }

  const elapsed = Date.now() - started;
  console.log(`\n${recovered}/${candidates.length} messages recovered by the LLM`);
  console.log(`${Math.round(elapsed / Math.max(candidates.length, 1))} ms per call average`);
  console.log('\nIf recovery is low, the rules are probably the better investment —');
  console.log('`npm run coverage` ranks the destination phrases that still fail.');
}

void main();
