import { openDb } from '../src/db/index.js';
import { loadGazetteer } from '../src/db/gazetteer.js';
import { parseMessage } from '@horizont/parser';

const db = openDb(process.env['DB_PATH'] ?? './data/map.db');
const gaz = loadGazetteer(db);
const rows = db.prepare(
  "SELECT text FROM messages WHERE is_sensitive = 0 AND text <> ''",
).all() as { text: string }[];

const TARGET = /бпла|шахед|герань|каб|ракет|реактивн|балістик|авіаці/iu;
let targets = 0, course = 0, origin = 0, parsed = 0, missedWithTarget = 0;
for (const r of rows) {
  const res = parseMessage(r.text, gaz);
  if (res.targets.length) parsed++;
  else if (TARGET.test(r.text)) missedWithTarget++;
  for (const t of res.targets) {
    targets++;
    if (t.courseDeg !== null) course++;
    if (t.fromLat !== null) origin++;
  }
}
const pct = (n: number, d: number) => ((n / d) * 100).toFixed(1) + '%';
console.log(`messages=${rows.length}  parsed=${parsed} (${pct(parsed, rows.length)})  ` +
  `missed-with-target-word=${missedWithTarget}`);
console.log(`targets=${targets}  course=${course} (${pct(course, targets)})  ` +
  `origin=${origin} (${pct(origin, targets)})`);
db.close();
