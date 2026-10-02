import type { Me, Snapshot } from '@horizont/contract';

/**
 * The last snapshot and the user record, so the app boots instantly and offline.
 * Storage can be unavailable (private mode, quota); every access is guarded and the
 * app works without it. The user's location is never stored here.
 */
const SNAPSHOT_KEY = 'horizont:snapshot:v1';
const ME_KEY = 'horizont:me:v1';
const PREFS_KEY = 'horizont:prefs:v1';

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked: the app still works, it just will not boot offline */
  }
}

export function isSnapshot(x: unknown): x is Snapshot {
  if (typeof x !== 'object' || x === null) return false;
  const s = x as Record<string, unknown>;
  return (
    typeof s.seq === 'number' &&
    typeof s.at === 'number' &&
    Array.isArray(s.alerts) &&
    Array.isArray(s.tracks) &&
    Array.isArray(s.sources)
  );
}

export const loadSnapshot = (): Snapshot | null => {
  const s = read<unknown>(SNAPSHOT_KEY);
  return isSnapshot(s) ? s : null;
};
export const saveSnapshot = (s: Snapshot | null): void => write(SNAPSHOT_KEY, s);
export const loadMe = (): Me | null => read<Me>(ME_KEY);
export const saveMe = (me: Me | null): void => write(ME_KEY, me);

export interface Prefs {
  onlyMyOblast: boolean;
  /** The user opted in to geolocation; coordinates themselves are never stored. */
  locate: boolean;
  theme: 'dark' | 'light';
}

const DEFAULT_PREFS: Prefs = { onlyMyOblast: false, locate: false, theme: 'dark' };

export function loadPrefs(): Prefs {
  return { ...DEFAULT_PREFS, ...(read<Partial<Prefs>>(PREFS_KEY) ?? {}) };
}

export function savePrefs(p: Prefs): void {
  write(PREFS_KEY, p);
}
