import Database from 'better-sqlite3';
import { Gazetteer } from '../src/parser/gazetteer.js';
import { parseMessage } from '../src/parser/index.js';

const db = new Database(process.argv[2]!, { readonly: true });
const gazetteer = new Gazetteer(db);
const rows = db.prepare(`SELECT text FROM messages WHERE is_sensitive = 0 AND text <> ''`)
  .all() as { text: string }[];

const launches = new Map<string, { n: number; types: Set<string> }>();
const demoted = new Map<string, number>();

for (const row of rows) {
  for (const t of parseMessage(row.text, gazetteer).targets) {
    if (t.relation === 'launch') {
      const key = t.fromName ?? '?';
      const e = launches.get(key) ?? { n: 0, types: new Set<string>() };
      e.n++; e.types.add(t.type); launches.set(key, e);
    } else if (t.relation === 'from' && /пуск/i.test(t.sourceLine ?? '')) {
      const k = `${t.fromName ?? '?'} (${t.type})`;
      demoted.set(k, (demoted.get(k) ?? 0) + 1);
    }
  }
}

console.log(`messages: ${rows.length}`);
console.log('\n--- launch markers still drawn ---');
for (const [name, e] of [...launches].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${String(e.n).padStart(4)}  ${name.padEnd(24)} ${[...e.types].join(',')}`);
}
console.log('\n--- "пуск" lines demoted to an invisible origin ---');
for (const [k, n] of [...demoted].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  console.log(`  ${String(n).padStart(4)}  ${k}`);
}
