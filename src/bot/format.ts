import type { TargetType } from '../parser/targetTypes.js';
import type { MatchReason } from '../notify/proximity.js';

/** Bot copy is Ukrainian, matching the settlement names themselves. */
const TYPE_LABELS: Record<TargetType, string> = {
  uav: 'БпЛА',
  jet_uav: 'Реактивний БпЛА',
  cruise: 'Крилата ракета',
  ballistic: 'Балістика',
  kab: 'КАБ',
  aviation: 'Авіація',
  recon: 'Розвідник',
  unknown: 'Ціль',
};

export function typeLabel(type: TargetType): string {
  return TYPE_LABELS[type] ?? TYPE_LABELS.unknown;
}

/**
 * Escape a value interpolated into an HTML-parsed message.
 *
 * Every send uses `parse_mode: 'HTML'` so the fixed copy can carry <b> tags. Telegram
 * rejects the *whole* message with 400 if the markup does not parse, which means one
 * settlement name containing `&` or `<` would silently drop the entire warning for
 * that user — the batch, not just the line. No gazetteer name contains those today,
 * but the names come from OSM and the channels, and neither is ours to guarantee.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export interface AlertLine {
  type: TargetType;
  count: number;
  toName: string | null;
  /** Distance to the place this line names — the number printed beside the name. */
  distanceKm: number;
  /** Minutes until it could reach the reader, when it is pointed at them. */
  etaMin: number | null;
  reason: MatchReason;
}

/**
 * One warning, in the form the reader will actually parse at 04:00.
 *
 * "⚠️ Реактивний БпЛА, курс на Жашків, ~201 км від вас" was read — correctly — as
 * "Zhashkiv is 201 km away". It is 106. The 201 was how far the drone was, a
 * different fact printed under the name of the town. Two numbers were being collapsed
 * into one, and which one you got depended on why the alert fired.
 *
 * So each number is now tied to the thing it measures: the distance sits in brackets
 * against the place name, and the time-to-reach is labelled "до вас" and appears only
 * when the target is actually pointed at the reader.
 */
export function formatAlertLine(line: AlertLine): string {
  const count = line.count > 1 ? ` ×${line.count}` : '';
  const km = `~${Math.round(line.distanceKm)} км від вас`;
  const name = line.toName === null ? null : escapeHtml(line.toName);

  const where = name
    ? line.reason === 'in_radius'
      ? `${name} (${km})`
      : `курс на ${name} (${km})`
    : `${km}`;

  // Under a minute is "вже поруч", not "~0 хв".
  const eta = line.etaMin === null ? ''
    : line.etaMin < 1 ? ' · вже поруч'
    : ` · до вас ~${Math.round(line.etaMin)} хв`;

  return `⚠️ ${typeLabel(line.type)}${count} — ${where}${eta}`;
}

/**
 * Several targets in one message rather than several messages.
 *
 * During a mass attack a single user can match dozens of targets within a minute.
 * The spec's per-target cooldown does not bound that, and a burst of separate
 * notifications is how an alerting bot gets muted.
 */
export function formatAlertBatch(lines: AlertLine[]): string {
  const unique = dedupe(lines);
  if (unique.length === 1) return formatAlertLine(unique[0]!);
  return unique.map(formatAlertLine).join('\n');
}

/**
 * Collapse lines describing the same thing.
 *
 * Three channels reporting one drone produce three targets, and listing "Реактивный
 * БпЛА, район Одеса" three times in a row reads as noise rather than urgency. The
 * nearest reading of each (type, place) wins; the suppressed targets are still
 * recorded in the ledger by the caller so they cannot alert again later.
 */
function dedupe(lines: AlertLine[]): AlertLine[] {
  const best = new Map<string, AlertLine>();

  for (const line of lines) {
    const key = subjectOf(line);
    const current = best.get(key);
    if (!current || line.distanceKm < current.distanceKm) {
      best.set(key, current ? { ...line, count: Math.max(line.count, current.count) } : line);
    } else if (line.count > current.count) {
      best.set(key, { ...current, count: line.count });
    }
  }

  return [...best.values()].sort((a, b) => a.distanceKm - b.distanceKm);
}

/**
 * What a warning is *about*, as the reader would say it: this kind of thing, over
 * this place, for this reason.
 *
 * Deliberately not the target's row id. Three channels reporting one drone produce
 * three rows, and each fresh message about the same drone produces another — so an
 * id-keyed anti-spam ledger never suppressed anything, and "БпЛА — Козятин, ~1 км від
 * вас" arrived five times in fourteen minutes. The spec's rule is one message per
 * target per five minutes, and to the person reading it a target is one drone over
 * one town, not a row.
 */
export function subjectOf(line: Pick<AlertLine, 'type' | 'toName' | 'reason'>): string {
  return `${line.type}|${line.toName ?? ''}|${line.reason}`;
}

export const HELP = [
  '🛡 <b>Horizont</b> — сповіщення про повітряні цілі.',
  '',
  'Надішліть свою геолокацію (скріпка → Location), щоб отримувати попередження.',
  'Live-локація оновлюється автоматично, поки вона активна.',
  '',
  'Тривоги приходять по <b>вашому району</b>, а не по всій області.',
  '',
  '<b>Команди</b>',
  '/radius 30 — радіус сповіщення в км (типово 40)',
  '/status — поточні налаштування',
  '/stop — вимкнути сповіщення',
  '/start — увімкнути знову',
  '',
  'Координати зберігаються лише на сервері й нікуди не передаються.',
  '',
  'Розробка — @f0zik',
].join('\n');
