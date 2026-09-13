import { openDb } from '../src/db/index.js';
import { Gazetteer } from '../src/parser/gazetteer.js';
import { parseMessage } from '../src/parser/index.js';

const db = openDb(process.env['DB_PATH'] ?? './data/map.db');
const gaz = new Gazetteer(db);
const rows = db.prepare('SELECT text FROM messages WHERE is_sensitive = 0 AND text <> \'\'').all() as { text: string }[];

let targets = 0, course = 0, dest = 0, origin = 0, msgsWithTargets = 0;
for (const r of rows) {
  const res = parseMessage(r.text, gaz);
  if (res.targets.length) msgsWithTargets++;
  for (const t of res.targets) {
    targets++;
    if (t.courseDeg !== null) course++;
    if (t.toLat !== null) dest++;
    if (t.fromLat !== null) origin++;
  }
}
const pct = (n: number) => ((n / targets) * 100).toFixed(1) + '%';
console.log(`messages=${rows.length} withTargets=${msgsWithTargets} targets=${targets}`);
console.log(`course=${course} (${pct(course)})  origin=${origin} (${pct(origin)})  dest=${dest} (${pct(dest)})`);
db.close();
