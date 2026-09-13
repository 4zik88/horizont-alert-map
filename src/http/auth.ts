import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../config.js';

/**
 * Access control for the map.
 *
 * The map is reachable only by a secret link. The token arrives once in the URL
 * path, is exchanged for an httpOnly cookie, and the browser is redirected to a
 * clean URL — because a token left in the query string leaks through the `Referer`
 * header to every tile server the page talks to, and into Railway's access logs.
 *
 * A wrong or missing token gets **404, never 403**: a 403 confirms that a valid
 * token exists to be guessed.
 */

const COOKIE_NAME = 'hz';
const COOKIE_MAX_AGE_DAYS = 180;

/** Derive the cookie value from the token so no session store is needed. */
function cookieValue(token: string): string {
  return createHmac('sha256', token).update('horizont-map-v1').digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function isConfigured(): boolean {
  return (config.MAP_TOKEN ?? '').length > 0;
}

/** Does this request already carry a valid session cookie? */
export function hasValidCookie(req: IncomingMessage): boolean {
  const token = config.MAP_TOKEN;
  if (!token) return false;

  const header = req.headers.cookie ?? '';
  const match = header.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!match) return false;

  return safeEqual(match.slice(COOKIE_NAME.length + 1), cookieValue(token));
}

export function isValidToken(candidate: string): boolean {
  const token = config.MAP_TOKEN;
  return token !== undefined && token.length > 0 && safeEqual(candidate, token);
}

/** Exchange a valid token for a cookie and redirect to a URL that no longer has it. */
export function grantSession(res: ServerResponse, redirectTo: string): void {
  const token = config.MAP_TOKEN!;
  const secure = config.NODE_ENV === 'production' ? '; Secure' : '';

  res.writeHead(302, {
    location: redirectTo,
    'set-cookie':
      `${COOKIE_NAME}=${cookieValue(token)}; Path=/; Max-Age=${COOKIE_MAX_AGE_DAYS * 86400}` +
      `; HttpOnly; SameSite=Lax${secure}`,
    // Belt and braces: the redirect itself must never be cached or indexed.
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex, nofollow, noarchive',
  });
  res.end();
}

/** Suggest a token for first-time setup. Never logged, only printed on request. */
export function suggestToken(): string {
  return randomBytes(24).toString('base64url');
}
