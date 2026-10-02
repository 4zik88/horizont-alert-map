import { FetchError } from '../types.js';

const USER_AGENT = 'horizont-alert/0.1 (private family air-alert tool)';

export interface PageCursor {
  before?: number;
  after?: number;
}

export function buildUrl(channel: string, cursor: PageCursor = {}): string {
  const url = new URL(`https://t.me/s/${channel}`);
  if (cursor.before !== undefined) url.searchParams.set('before', String(cursor.before));
  if (cursor.after !== undefined) url.searchParams.set('after', String(cursor.after));
  return url.toString();
}

/**
 * Fetches one preview page.
 *
 * The page sends `cache-control: no-store` and no ETag/Last-Modified, so conditional
 * requests are impossible — every poll is a full ~110 KB body. That is why the poller
 * staggers and jitters instead of polling three channels in lockstep.
 *
 * A redirect means the channel is gone, private, or misspelled (a non-existent
 * channel answers 302, not 404), so it is reported as permanent rather than retried.
 */
export async function fetchChannelPage(
  channel: string,
  cursor: PageCursor,
  timeoutMs: number,
): Promise<string> {
  const url = buildUrl(channel, cursor);

  let response: Response;
  try {
    response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': USER_AGENT, 'accept-language': 'uk,en;q=0.8' },
    });
  } catch (cause) {
    const err = cause as Error;
    const kind = err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timeout' : 'network';
    throw new FetchError(kind, `${kind} fetching ${channel}: ${err.message}`);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new FetchError(
      'redirect',
      `channel ${channel} redirected (${response.status}) — gone, private, or misspelled`,
      response.status,
    );
  }

  if (!response.ok) {
    throw new FetchError(
      'http',
      `channel ${channel} returned HTTP ${response.status}`,
      response.status,
      parseRetryAfter(response.headers.get('retry-after')),
    );
  }

  return response.text();
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;

  const seconds = Number.parseInt(header, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());

  return undefined;
}
