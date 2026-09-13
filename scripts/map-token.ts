/**
 * Prints a fresh map token and the link it produces.
 *
 *   npm run map:token
 *
 * The map is reachable only through this link. The token is used once, in the path,
 * and the server immediately swaps it for an httpOnly cookie and redirects to a clean
 * URL — so it never reaches a Referer header, an access log, or the address bar.
 */
import { suggestToken } from '../src/http/auth.js';

const token = suggestToken();
const host = process.env['MAP_HOST'] ?? 'https://<your-app>.up.railway.app';

console.log('Add this to your environment (Railway variable, or .env locally):\n');
console.log(`  MAP_TOKEN=${token}\n`);
console.log('Then open, once, on each device that should have the map:\n');
console.log(`  ${host}/t/${token}\n`);
console.log('It sets a cookie valid for 180 days and redirects to a clean URL.');
console.log('Anyone without the cookie gets a plain 404 — the server never reveals');
console.log('that a valid link exists. Rotate by changing MAP_TOKEN; every device');
console.log('then needs the new link once.');
