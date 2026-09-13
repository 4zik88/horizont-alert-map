import type { TargetType } from '../parser/targetTypes.js';
import type { MatchReason } from '../notify/proximity.js';

/** Bot copy is Russian, matching the wording the spec asked for. */
const TYPE_LABELS: Record<TargetType, string> = {
  uav: 'БпЛА',
  jet_uav: 'Реактивный БпЛА',
  cruise: 'Крылатая ракета',
  ballistic: 'Баллистика',
  kab: 'КАБ',
  aviation: 'Авиация',
  recon: 'Разведчик',
  unknown: 'Цель',
};

export function typeLabel(type: TargetType): string {
  return TYPE_LABELS[type] ?? TYPE_LABELS.unknown;
}

export interface AlertLine {
  type: TargetType;
  count: number;
  toName: string | null;
  distanceKm: number;
  reason: MatchReason;
}

/** "⚠️ БпЛА, курс на Охтирка, ~23 км от вас" — the format the spec specified. */
export function formatAlertLine(line: AlertLine): string {
  const count = line.count > 1 ? ` ×${line.count}` : '';
  const where = line.toName
    ? line.reason === 'in_radius'
      ? `район ${line.toName}`
      : `курс на ${line.toName}`
    : line.reason === 'in_radius'
      ? 'рядом с вами'
      : 'курс в вашу сторону';

  return `⚠️ ${typeLabel(line.type)}${count}, ${where}, ~${Math.round(line.distanceKm)} км от вас`;
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
    const key = `${line.type}|${line.toName ?? ''}|${line.reason}`;
    const current = best.get(key);
    if (!current || line.distanceKm < current.distanceKm) {
      best.set(key, current ? { ...line, count: Math.max(line.count, current.count) } : line);
    } else if (line.count > current.count) {
      best.set(key, { ...current, count: line.count });
    }
  }

  return [...best.values()].sort((a, b) => a.distanceKm - b.distanceKm);
}

export const HELP = [
  '🛡 <b>Horizont</b> — оповещение о воздушных целях.',
  '',
  'Отправьте свою геолокацию (скрепка → Location), чтобы получать предупреждения.',
  'Live-локация обновляется автоматически, пока она активна.',
  '',
  '<b>Команды</b>',
  '/radius 30 — радиус оповещения в км (сейчас по умолчанию 40)',
  '/status — текущие настройки',
  '/stop — отключить оповещения',
  '/start — включить снова',
  '',
  'Координаты хранятся только на сервере и никуда не передаются.',
].join('\n');
