import { openDb } from '../src/db/index.js';
import { distanceKm } from '@horizont/geo';
import { config } from '../src/config.js';

const db = await openDb(config.DATABASE_URL);
const { rows: [user] } = await db.query<{ lat: number; lon: number; radius_km: number }>(
  'SELECT lat, lon, radius_km FROM users WHERE is_active = 1 ORDER BY id LIMIT 1',
);
if (!user) {
  console.log('no active user');
  process.exit(0);
}

const { rows } = await db.query<{
  type: string; to_name: string; to_lat: number; to_lon: number;
  confidence: number; observed_at: number;
}>(`
  SELECT type, to_name, to_lat, to_lon, confidence, observed_at
    FROM targets
   WHERE observed_at > $1 AND to_lat IS NOT NULL AND confidence >= 0.6
`, [Date.now() - 30 * 60_000]);

const near = rows
  .map((r) => ({ ...r, km: distanceKm(user.lat, user.lon, r.to_lat, r.to_lon) }))
  .sort((a, b) => a.km - b.km)
  .slice(0, 5);

console.log(`radius now: ${user.radius_km} km | live targets in the last 30 min: ${rows.length}`);
for (const n of near) {
  console.log(`  ${Math.round(n.km).toString().padStart(4)} km  ${n.type.padEnd(8)} ${n.to_name}`);
}
await db.close();
