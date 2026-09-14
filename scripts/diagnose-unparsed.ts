import { openDb } from '../src/db/index.js';
import { Gazetteer } from '../src/parser/gazetteer.js';
import { parseMessage } from '../src/parser/index.js';
import { classifyType } from '../src/parser/targetTypes.js';

const db = openDb(process.env['DB_PATH'] ?? './data/map.db');
const gaz = new Gazetteer(db);
const rows = db.prepare(
  `SELECT text FROM messages WHERE is_sensitive = 0 AND text <> ''`,
).all() as { text: string }[];

const TARGET = /бпла|шахед|герань|каб|ракет|реактивн|балістик|авіаці/iu;
const CUE = /(?<![\p{L}\p{N}])(курс(?:ом)?\s+на|[ву]\s+напрямку|в\s+б[іi]к|повз|через|над|на)\s+/iu;
const CAP = /(?<![\p{L}\p{N}])([А-ЯІЇЄҐ][^\s,.;:!?()]*)/gu;

const reasons = new Map<string, number>();
const samples = new Map<string, string[]>();
const unresolved = new Map<string, number>();

function note(reason: string, line: string) {
  reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  const s = samples.get(reason) ?? [];
  if (s.length < 4) { s.push(line.slice(0, 78)); samples.set(reason, s); }
}

for (const { text } of rows) {
  if (!TARGET.test(text)) continue;
  if (parseMessage(text, gaz).targets.length > 0) continue;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || !TARGET.test(line)) continue;
    if (classifyType(line, 'unknown') === 'unknown') { note('type not recognised', line); continue; }
    if (!CUE.test(line)) { note('no relation cue', line); continue; }

    // A cue is present: are the capitalised names in the line resolvable?
    const names = [...line.matchAll(CAP)].map((m) => m[1]!)
      .filter((n) => n.length > 2 && !TARGET.test(n));
    const misses = names.filter((n) => !gaz.resolve(n, null));
    if (names.length === 0) note('cue but no capitalised name', line);
    else if (misses.length === names.length) {
      note('no name resolves in the gazetteer', line);
      for (const m of misses) unresolved.set(m, (unresolved.get(m) ?? 0) + 1);
    } else note('other', line);
  }
}

console.log('=== why target-bearing messages yield nothing ===');
for (const [r, n] of [...reasons].sort((a, b) => b[1] - a[1])) {
  console.log(`\n${n.toString().padStart(4)}  ${r}`);
  for (const s of samples.get(r) ?? []) console.log(`      ${s}`);
}
console.log('\n=== most frequent unresolved names ===');
console.log([...unresolved].sort((a, b) => b[1] - a[1]).slice(0, 25)
  .map(([n, c]) => `${n}(${c})`).join('  '));
db.close();
