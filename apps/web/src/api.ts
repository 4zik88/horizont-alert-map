import type { Me, Snapshot } from '@horizont/contract';
import type { RegionCollection } from './regions.js';

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new HttpError(res.status, `${url}: ${res.status}`);
  return (await res.json()) as T;
}

export const fetchMe = (): Promise<Me> => getJson<Me>('/api/me');
export const fetchSnapshot = (): Promise<Snapshot> => getJson<Snapshot>('/api/snapshot');
export const fetchHistory = (at: number, signal?: AbortSignal): Promise<Snapshot> =>
  getJson<Snapshot>(`/api/history?at=${Math.round(at)}`, signal);
export const fetchRegions = (): Promise<RegionCollection> =>
  getJson<RegionCollection>('/api/regions.geojson');

export type LoginResult = 'ok' | 'invalid' | 'rate-limited' | 'error';

/** One-time code from the bot, for an installed app that has its own cookie jar. */
export async function login(code: string): Promise<LoginResult> {
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (res.status === 204 || res.ok) return 'ok';
    if (res.status === 400 || res.status === 401) return 'invalid';
    if (res.status === 429) return 'rate-limited';
    return 'error';
  } catch {
    return 'error';
  }
}

export async function logout(): Promise<void> {
  await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
}
