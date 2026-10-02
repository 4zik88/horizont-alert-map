/**
 * Lists every place name the fuzzy fallback resolved in the stored corpus, with the
 * line it came from, so each one can be checked by eye. Read-only.
 *   pnpm fuzzy:audit            all hits
 *   pnpm fuzzy:audit --off      coverage with fuzzy disabled, for comparison
 */
import { connect } from '@horizont/db';
import { config } from '../src/config.js';
import { loadGazetteer } from '../src/db/gazetteer.js';
import { parseMessage } from '@horizont/parser';

const db = connect(config.DATABASE_URL);
const gazetteer = await loadGazetteer(db);
gazetteer.fuzzyEnabled = !process.argv.includes('--off');

const hits = new Map<string, { name: string; oblast: string | null; d: number; n: number; line: string }>();
let current = '';
gazetteer.onFuzzy = (phrase, hit) => {
  const key = `${phrase} -> ${hit.name}`;
  const prev = hits.get(key);
  if (prev) prev.n++;
  else hits.set(key, { name: hit.name, oblast: hit.oblast, d: hit.fuzzy ?? 0, n: 1, line: current });
};

const { rows } = await db.query<{ text: string }>(
  `SELECT text FROM messages WHERE is_sensitive = 0 AND text <> '' ORDER BY id`,
);
await db.close();
let parsed = 0;
let targets = 0;
for (const { text } of rows) {
  current = text.replace(/\s+/g, ' ').slice(0, 160);
  const r = parseMessage(text, gazetteer);
  if (r.state === 'parsed') parsed++;
  targets += r.targets.length;
}
console.log(`fuzzy ${gazetteer.fuzzyEnabled ? 'on' : 'off'}: parsed ${parsed}/${rows.length}, targets ${targets}`);
for (const [key, h] of [...hits].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`${String(h.n).padStart(3)}x d=${h.d} ${key} [${h.oblast}]  «${h.line}»`);
}
