import { openDb } from '../src/db/index.js';
import { distanceKm } from '../src/parser/rules.js';
import { config } from '../src/config.js';

const db = openDb(config.DB_PATH);
const user = db.prepare('SELECT lat, lon, radius_km FROM users WHERE is_active = 1 LIMIT 1')
  .get() as { lat: number; lon: number; radius_km: number };

const rows = db.prepare(`
  SELECT type, to_name, to_lat, to_lon, confidence, observed_at
    FROM targets
   WHERE observed_at > ? AND to_lat IS NOT NULL AND confidence >= 0.6
`).all(Date.now() - 30 * 60_000) as {
  type: string; to_name: string; to_lat: number; to_lon: number;
  confidence: number; observed_at: number;
}[];

const near = rows
  .map((r) => ({ ...r, km: distanceKm(user.lat, user.lon, r.to_lat, r.to_lon) }))
  .sort((a, b) => a.km - b.km)
  .slice(0, 5);

console.log(`radius now: ${user.radius_km} km | live targets in the last 30 min: ${rows.length}`);
for (const n of near) {
  console.log(`  ${Math.round(n.km).toString().padStart(4)} km  ${n.type.padEnd(8)} ${n.to_name}`);
}
db.close();
