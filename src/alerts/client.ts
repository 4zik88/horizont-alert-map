import { logger } from '../logger.js';
import { OBLASTS } from '../parser/oblasts.js';

/**
 * alerts.in.ua client.
 *
 * Uses the IoT endpoint, which returns a fixed-order string of one character per
 * oblast — far smaller than the full alert list and intended for exactly this kind of
 * frequent polling. Character meanings: 'A' active, 'P' partial, 'N' none.
 *
 * The oblast order below is defined by the API, not by us; it must not be reordered.
 */
const IOT_URL = 'https://api.alerts.in.ua/v1/iot/active_air_raid_alerts_by_oblast.json';

/** Fixed API order. Index N of the response string maps to entry N here. */
const IOT_ORDER: string[] = [
  'vinnytska', 'volynska', 'dnipropetrovska', 'donetska', 'zhytomyrska', 'zakarpatska',
  'zaporizka', 'ivano-frankivska', 'kyivska', 'kirovohradska', 'luhanska', 'lvivska',
  'mykolaivska', 'odeska', 'poltavska', 'rivnenska', 'sumska', 'ternopilska',
  'kharkivska', 'khersonska', 'khmelnytska', 'cherkaska', 'chernivetska',
  'chernihivska', 'kyiv', 'krym', 'sevastopol',
];

export interface AlertState {
  /** Oblast key -> whether an air-raid alert is active (full or partial). */
  active: Map<string, boolean>;
}

export async function fetchAlertState(token: string, timeoutMs: number): Promise<AlertState> {
  const response = await fetch(`${IOT_URL}?token=${encodeURIComponent(token)}`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`alerts.in.ua returned HTTP ${response.status}`);
  }

  const raw = (await response.text()).trim().replace(/^"|"$/g, '');
  return parseIotString(raw);
}

/**
 * Parse the IoT status string.
 *
 * Exported for testing: the mapping from position to oblast is the part most likely
 * to break silently if the API changes, and a wrong mapping would send the Kharkiv
 * all-clear to someone in Lviv.
 */
export function parseIotString(raw: string): AlertState {
  const active = new Map<string, boolean>();

  if (raw.length < IOT_ORDER.length) {
    logger.warn(
      { length: raw.length, expected: IOT_ORDER.length },
      'alerts.in.ua response shorter than the known oblast order — ignoring',
    );
    return { active };
  }

  IOT_ORDER.forEach((key, index) => {
    const flag = raw[index];
    // 'P' (partial) counts as active: a partial alert still means take cover.
    active.set(key, flag === 'A' || flag === 'P');
  });

  return { active };
}

/** Oblast keys the notifier can actually report on. */
export const KNOWN_OBLASTS = new Set(OBLASTS.map((o) => o.key));
