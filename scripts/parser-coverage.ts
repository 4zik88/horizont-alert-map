/**
 * Measures the parser against the stored corpus and prints what it still misses.
 *
 * Run it after any parser or gazetteer change:
 *   npm run coverage
 *
 * Read-only — it parses in memory and writes nothing. The "top misses" list is the
 * useful part: it is ranked by frequency, so the next rule worth writing is at the top.
 */
import Database from 'better-sqlite3';
import { config } from '../src/config.js';
import { Gazetteer } from '../src/parser/gazetteer.js';
import { parseMessage } from '../src/parser/index.js';
import { stripBoilerplate } from '../src/parser/clean.js';
import { BOUNDARY_LEFT } from '../src/parser/regex.js';

const db = new Database(config.DB_PATH, { readonly: true });
const gazetteer = new Gazetteer(db);

const toponyms = db.prepare('SELECT COUNT(*) c FROM toponyms').get() as { c: number };
if (toponyms.c === 0) {
  console.error('Gazetteer is empty — run `npm run build:toponyms` first.');
  process.exit(1);
}

const messages = db
  .prepare(`SELECT text FROM messages WHERE is_sensitive = 0 AND text <> ''`)
  .all() as { text: string }[];

let parsed = 0;
let unparsed = 0;
let wouldCallLlm = 0;
let targets = 0;
const byType = new Map<string, number>();
const lowConfidence: string[] = [];

for (const { text } of messages) {
  const result = parseMessage(text, gazetteer);
  if (result.state === 'parsed') parsed++;
  else unparsed++;
  if (result.needsLlm) wouldCallLlm++;
  targets += result.targets.length;
  for (const t of result.targets) {
    byType.set(t.type, (byType.get(t.type) ?? 0) + 1);
    if (t.confidence < 0.6 && lowConfidence.length < 10) {
      lowConfidence.push(`${t.confidence.toFixed(2)}  ${t.sourceLine.slice(0, 70)}`);
    }
  }
}

const pct = (n: number) => ((n / messages.length) * 100).toFixed(1);
console.log(`messages:        ${messages.length}`);
console.log(`parsed:          ${parsed} (${pct(parsed)}%)`);
console.log(`unparsed:        ${unparsed} (${pct(unparsed)}%)  -> feed as plain text`);
console.log(`would call LLM:  ${wouldCallLlm} (${pct(wouldCallLlm)}%)`);
console.log(`targets:         ${targets}`);
console.log(`\nby type:`);
for (const [type, n] of [...byType].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${type.padEnd(10)} ${n}`);
}

// Destination phrases the gazetteer could not resolve, ranked — the tuning worklist.
const CUE = new RegExp(
  `${BOUNDARY_LEFT}(?:курс(?:ом)?\\s+на|[ву]\\s+напрямку|повз|через|над|на)\\s+([А-ЯІЇЄҐ][^\\s,.;:!?()]*(?:\\s+[А-ЯІЇЄҐ][^\\s,.;:!?()]*){0,2})`,
  'giu',
);
const misses = new Map<string, number>();
for (const { text } of messages) {
  for (const line of stripBoilerplate(text).split('\n')) {
    for (const match of line.matchAll(CUE)) {
      const phrase = match[1]!;
      if (!gazetteer.resolve(phrase)) misses.set(phrase, (misses.get(phrase) ?? 0) + 1);
    }
  }
}
console.log(`\nunresolved destination phrases (top 25):`);
for (const [phrase, n] of [...misses].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  console.log(`  ${String(n).padStart(4)}x  ${phrase}`);
}
if (lowConfidence.length > 0) {
  console.log(`\nlow-confidence samples:`);
  lowConfidence.forEach((l) => console.log(`  ${l}`));
}
