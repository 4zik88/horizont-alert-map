import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../config.js';

/**
 * Access control for the map.
 *
 * The map is reachable only by a secret link. `/t/<token>` both serves the page and
 * sets an httpOnly cookie, which is what the page's own requests — assets, state,
 * manifest — then travel with. The token never leaves in a `Referer`: every response
 * carries `referrer-policy: strict-origin`, and the page repeats it in a meta tag, so
 * tile servers see the origin and nothing else.
 *
 * It used to redirect to a clean `/` instead of serving the page, which made the
 * cookie the *only* way back in. That is a single point of failure on a phone, and it
 * failed: iOS gives a home-screen app its own cookie jar, Telegram's in-app browser
 * another, and Safari purges site data for a site left alone long enough. Each of
 * those turned the map into a flat 404 with nothing on screen to explain it. The link
 * now works on its own, in any jar, however old.
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

/**
 * Attach the session cookie to a response that has not been written yet.
 *
 * Sets the header rather than sending anything, so the caller can go on to serve the
 * page in the same response: `writeHead` merges what is already set, and `set-cookie`
 * survives that merge. One round trip instead of two, and the page and its permission
 * to load arrive together.
 */
export function setSessionCookie(res: ServerResponse): void {
  const token = config.MAP_TOKEN!;
  const secure = config.NODE_ENV === 'production' ? '; Secure' : '';

  res.setHeader(
    'set-cookie',
    `${COOKIE_NAME}=${cookieValue(token)}; Path=/; Max-Age=${COOKIE_MAX_AGE_DAYS * 86400}` +
      `; HttpOnly; SameSite=Lax${secure}`,
  );
}

/** Suggest a token for first-time setup. Never logged, only printed on request. */
export function suggestToken(): string {
  return randomBytes(24).toString('base64url');
}
