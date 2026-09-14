import { logger } from '../logger.js';
import { OBLASTS } from '../parser/oblasts.js';

/**
 * Air-raid alert state, from one of two providers.
 *
 * Default is **alerts.com.ua**, which needs no token — the map and the bot work the
 * moment the service is deployed, with nothing to register for. alerts.in.ua is
 * supported too and takes over automatically when a token is configured.
 *
 * A third keyless source (vadimklimenko.com) was checked and rejected: its newest
 * state change was from 2022, so it reports only the permanently occupied regions
 * and would silently never fire a real alert.
 */

/**
 * Alert severity.
 *
 * Several oblasts run a two-level system: a yellow level for drone threat and a red
 * level for missile threat. Collapsing them to one colour throws away the
 * distinction that decides whether you move to a corridor or to a shelter, so the
 * level is carried end to end and painted separately on the map.
 */
export type AlertLevel = 'none' | 'partial' | 'full';

export interface AlertState {
  /** Oblast key -> current alert level. */
  levels: Map<string, AlertLevel>;
  /**
   * Normalised names of the individual areas under warning, per oblast.
   *
   * Alerts are declared per raion, not per oblast. Shading a whole region because one
   * raion is alerted claims an emergency across an area the size of a small country,
   * so the map needs this finer list to paint what is actually warned.
   */
  areas: Map<string, string[]>;
  /** What is actually being tracked right now, when the source reports it. */
  threats: ThreatNote[];
}

/** Convenience for callers that only care whether anything is active. */
export function isActive(level: AlertLevel | undefined): boolean {
  return level === 'partial' || level === 'full';
}

export type AlertProvider = 'alerts_in_ua_public' | 'alerts_com_ua' | 'alerts_in_ua';

/** Threat activity currently tracked, for display alongside the alert state. */
export interface ThreatNote {
  time: string;
  kind: string;
  where: string;
}

const PUBLIC_SITREP_URL = 'https://api.alerts.in.ua/v3/alerts/active.md';
const COM_UA_URL = 'https://alerts.com.ua/api/states';
const IN_UA_URL = 'https://api.alerts.in.ua/v1/iot/active_air_raid_alerts_by_oblast.json';

/** Names as alerts.com.ua spells them, mapped onto our oblast keys. */
const NAME_TO_KEY = new Map<string, string>(
  OBLASTS.filter((o) => o.key !== 'krym').map((o) => [`${o.name} область`, o.key]),
);
NAME_TO_KEY.set('м. Київ', 'kyiv');
NAME_TO_KEY.set('Київ', 'kyiv');
NAME_TO_KEY.set('Автономна Республіка Крим', 'krym');
NAME_TO_KEY.set('АР Крим', 'krym');

interface ComUaState {
  name: string;
  alert: boolean;
}

export async function fetchAlertState(
  provider: AlertProvider,
  token: string | undefined,
  timeoutMs: number,
): Promise<AlertState> {
  if (provider === 'alerts_in_ua') return fetchInUa(token!, timeoutMs);
  if (provider === 'alerts_com_ua') return fetchComUa(timeoutMs);
  return fetchPublicSitrep(timeoutMs);
}

/**
 * The default source: alerts.in.ua's public situation report.
 *
 * Published explicitly for unauthenticated use, continuously updated, and — unlike
 * the keyless alternatives — it separates the standing administrative alerts over
 * occupied territory from live ones. alerts.com.ua was measured reporting a single
 * alert while eight oblasts were actually under one, precisely because those nominal
 * alerts are all it saw.
 */
async function fetchPublicSitrep(timeoutMs: number): Promise<AlertState> {
  const response = await fetch(PUBLIC_SITREP_URL, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'text/markdown, text/plain', 'user-agent': 'horizont-alert/0.1' },
  });

  if (!response.ok) throw new Error(`alerts.in.ua sitrep returned HTTP ${response.status}`);

  return parseSitrep(await response.text());
}

/** Ukrainian region names as the sitrep spells them, mapped onto our oblast keys. */
const UKR_NAME_TO_KEY = new Map<string, string>(
  OBLASTS.filter((o) => o.key !== 'krym' && o.key !== 'kyiv')
    .map((o) => [`${o.name} область`, o.key]),
);
UKR_NAME_TO_KEY.set('м. Київ', 'kyiv');
UKR_NAME_TO_KEY.set('Київ', 'kyiv');
UKR_NAME_TO_KEY.set('Автономна Республіка Крим', 'krym');

/** Raion names are masculine adjectives; hromadas are feminine, cities are bare. */
const RAION_NAME = /ий$/u;

/** How many raions each oblast has — the denominator for oblast-wide coverage. */
const OBLAST_RAIONS = new Map(OBLASTS.map((o) => [o.key, o.raions]));

/**
 * Parse the situation report.
 *
 * Exported for testing, because two things here are easy to get silently wrong: the
 * paragraphs describing occupied territory and Russian launch sites must be excluded
 * (they are permanent and would show as a country-wide emergency forever), and a
 * report whose shape has changed must yield nothing rather than an empty alert map,
 * which would read as a nationwide all-clear.
 */
export function parseSitrep(markdown: string): AlertState {
  const levels = new Map<string, AlertLevel>();
  const areas = new Map<string, string[]>();
  const threats: ThreatNote[] = [];

  const section = /## 3\. CURRENT WARNING STATUS([\s\S]*?)(?=\n## )/.exec(markdown);
  if (!section) {
    logger.warn('alerts.in.ua sitrep has no recognisable warning section — ignoring');
    return { levels, areas, threats };
  }

  // Every oblast starts at "no alert"; the report then raises the ones it lists.
  for (const oblast of OBLASTS) levels.set(oblast.key, 'none');

  for (const line of section[1]!.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('**')) continue;

    // These paragraphs are permanent and carry no live threat.
    if (/Nominal alerts|Cross-border launch-site/i.test(trimmed)) continue;

    const named = /\*\*[^(*]*\(([^)]+)\)\*\*\s*—\s*([^\n]*)/.exec(trimmed);
    if (!named) continue;

    const key = UKR_NAME_TO_KEY.get(named[1]!.trim());
    if (!key) continue;

    const description = named[2]!.toLowerCase();

    // "7 areas affected: Lypetska (Липецька), Iziumskyi (Ізюмський), ..." — the
    // Ukrainian name in brackets is what the raion polygons are keyed by.
    // Not `[^.]*`: the list itself contains periods ("m. Kharkiv (м. Харків)"),
    // which truncated it after the first entry. Take the rest of the line instead.
    const affected = /areas? affected:(.*)$/i.exec(trimmed);
    const names: string[] = [];
    if (affected) {
      for (const bracket of affected[1]!.matchAll(/\(([^)]+)\)/g)) {
        const raw = bracket[1]!.trim();
        // Skip the English-transliteration duplicates and hromada markers.
        if (!/[\u0400-\u04FF]/.test(raw)) continue;
        names.push(normaliseArea(raw));
      }
    }
    const unique = [...new Set(names)];

    /*
     * An artillery or street-fighting threat with no declared air raid alert is not
     * an air raid. The reference map marks those with a point icon and leaves the
     * oblast unfilled; tinting a whole oblast because one hromada is under a
     * shelling threat was the most over-broad thing on our map.
     */
    if (!description.includes('air raid alert')) continue;

    if (unique.length > 0) areas.set(key, unique);

    /*
     * Red versus yellow is *coverage*, not threat type — the same distinction the
     * tokened alerts.in.ua feed encodes as 'A' (oblast-wide) and 'P' (partial).
     * An alert naming every raion of the oblast is oblast-wide and red; one naming
     * a few raions or only hromadas is the yellow level. Reading it as "air raid
     * alert = red" painted Sumy and Odesa red while the reference showed yellow.
     *
     * Raion-level names are the masculine adjectival ones ("Сумський"); hromadas
     * are feminine ("Липецька") and cities come through as bare settlement names,
     * and neither counts toward oblast-wide coverage.
     */
    const raionsUnderAlert = unique.filter((name) => RAION_NAME.test(name)).length;
    const total = OBLAST_RAIONS.get(key) ?? 0;
    levels.set(key, total > 0 && raionsUnderAlert >= total ? 'full' : 'partial');
  }

  const activity = /## 4\. THREAT ACTIVITY([\s\S]*?)(?=\n## )/.exec(markdown);
  if (activity) {
    for (const line of activity[1]!.split('\n')) {
      const note = /^-\s*\*\*(\d{2}:\d{2})\s*—\s*([^*(]+)(?:\([^)]*\))?\*\*\s*over\s*([^—]+)/.exec(line.trim());
      if (note) {
        threats.push({
          time: note[1]!,
          kind: note[2]!.trim(),
          where: note[3]!.trim().replace(/\s+$/, ''),
        });
      }
    }
  }

  return { levels, areas, threats };
}

/**
 * Normalise an area name to the key the raion polygons use.
 *
 * The report writes "Ізюмський", "м. Харків", "Марганецька"; OSM writes
 * "Ізюмський район". Stripping the administrative words leaves a stable join key,
 * and a hromada or city simply fails to match — correct, since no polygon exists
 * for it at this level.
 */
export function normaliseArea(name: string): string {
  return name
    .replace(/^м\.\s*/iu, '')
    .replace(/\s*\[hromada\]\s*/iu, '')
    .replace(/\s*(?:район|громада)\s*$/iu, '')
    .toLowerCase()
    .replace(/['’ʼ`]/g, "'")
    .trim();
}

async function fetchComUa(timeoutMs: number): Promise<AlertState> {
  const response = await fetch(COM_UA_URL, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json', 'user-agent': 'horizont-alert/0.1' },
  });

  if (!response.ok) throw new Error(`alerts.com.ua returned HTTP ${response.status}`);

  const body = (await response.json()) as { states?: ComUaState[] };
  return parseComUa(body.states ?? []);
}

/**
 * Exported for testing. An unrecognised name is reported rather than ignored: if the
 * provider renames a region, the alert for it would otherwise vanish silently.
 */
export function parseComUa(states: ComUaState[]): AlertState {
  const levels = new Map<string, AlertLevel>();
  const areas = new Map<string, string[]>();
  const threats: ThreatNote[] = [];

  // A short list means the response is not what we expect. Treating it as truth would
  // mark every missing oblast "no alert" and fire a false all-clear to everyone.
  if (states.length < 20) {
    logger.warn({ count: states.length }, 'alerts.com.ua returned too few states — ignoring');
    return { levels, areas, threats };
  }

  for (const state of states) {
    const key = NAME_TO_KEY.get(state.name.trim());
    if (!key) {
      logger.warn({ name: state.name }, 'unrecognised oblast name from alerts.com.ua');
      continue;
    }
    // This provider reports a single boolean, so everything active reads as full.
    // Only alerts.in.ua distinguishes the yellow level.
    levels.set(key, state.alert === true ? 'full' : 'none');
  }

  return { levels, areas, threats };
}

async function fetchInUa(token: string, timeoutMs: number): Promise<AlertState> {
  const response = await fetch(`${IN_UA_URL}?token=${encodeURIComponent(token)}`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
  });

  if (!response.ok) throw new Error(`alerts.in.ua returned HTTP ${response.status}`);

  return parseIotString((await response.text()).trim().replace(/^"|"$/g, ''));
}

/** Fixed API order for the alerts.in.ua IoT string. Do not reorder. */
const IOT_ORDER: string[] = [
  'vinnytska', 'volynska', 'dnipropetrovska', 'donetska', 'zhytomyrska', 'zakarpatska',
  'zaporizka', 'ivano-frankivska', 'kyivska', 'kirovohradska', 'luhanska', 'lvivska',
  'mykolaivska', 'odeska', 'poltavska', 'rivnenska', 'sumska', 'ternopilska',
  'kharkivska', 'khersonska', 'khmelnytska', 'cherkaska', 'chernivetska',
  'chernihivska', 'kyiv', 'krym', 'sevastopol',
];

/**
 * Parse the alerts.in.ua IoT status string: one character per oblast, in a fixed
 * order. The position-to-oblast mapping is the part most likely to break silently —
 * a wrong index sends the Kharkiv all-clear to someone in Lviv.
 */
export function parseIotString(raw: string): AlertState {
  const levels = new Map<string, AlertLevel>();
  const areas = new Map<string, string[]>();
  const threats: ThreatNote[] = [];

  if (raw.length < IOT_ORDER.length) {
    logger.warn(
      { length: raw.length, expected: IOT_ORDER.length },
      'alerts.in.ua response shorter than the known oblast order — ignoring',
    );
    return { levels, areas, threats };
  }

  IOT_ORDER.forEach((key, index) => {
    const flag = raw[index];
    // 'A' is an oblast-wide alert (red); 'P' is the partial / yellow level.
    levels.set(key, flag === 'A' ? 'full' : flag === 'P' ? 'partial' : 'none');
  });

  return { levels, areas, threats };
}
