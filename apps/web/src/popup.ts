import type { Alert, Track } from '@horizont/contract';
import {
  TYPE_LABEL,
  TYPE_SHORT,
  confidence,
  esc,
  hhmm,
  minutesAgo,
  oblastName,
  sourceLink,
} from './format.js';
import { alertAreas, type RegionAlertState } from './regions.js';
import { isTrackStale } from './targets.js';

/** Text under the marker. A destination is labelled with an arrow: it is not there. */
export function markerLabel(t: Track): string {
  const type = TYPE_SHORT[t.type];
  if (t.last.kind === 'destination') return `→ ${type}`;
  if (t.last.kind === 'launch') return `пуск · ${type}`;
  // "≈": somewhere in a region, not at this spot.
  return t.last.area ? `≈ ${type}` : type;
}

/** One line saying what the coordinate means. */
export function placeLine(t: Track): string {
  const place = t.last.placeName ?? 'невідомий пункт';
  if (t.last.area && t.last.kind !== 'launch') {
    return t.last.kind === 'destination'
      ? `курс на ${place} обл. · ще не там`
      : `десь у межах: ${place} обл. · точне місце невідоме`;
  }
  switch (t.last.kind) {
    case 'position': {
      // Place names arrive in the nominative, so no preposition is glued to them.
      const rel = t.last.relation;
      const how = rel === 'past' ? ' (повз)' : rel === 'through' ? ' (через)' : '';
      return `місце: ${place}${how}`;
    }
    case 'destination':
      return `курс на ${place} · ще не там`;
    case 'launch':
      return `місце пуску: ${place} · не ціль`;
  }
}

/** Popup HTML for a target. Every string from the wire is escaped. */
export function trackPopupHtml(t: Track, now: number): string {
  const o = t.last;
  const stale = isTrackStale(t, now);
  const lines = [
    `<div class="pp-title">${esc(TYPE_LABEL[t.type])}${t.count > 1 ? ` <span class="pp-count">×${t.count}</span>` : ''}</div>`,
    `<div class="pp-place${o.kind === 'destination' ? ' pp-dest' : ''}">${esc(placeLine(t))}</div>`,
    o.fromName ? `<div>звідки: ${esc(o.fromName)}</div>` : '',
    `<div>${esc(minutesAgo(t.lastSeenAt, now))} (${hhmm(t.lastSeenAt)})${stale ? ' · <b>застаріло</b>' : ''}</div>`,
    o.headingDeg === null ? '<div>напрямок невідомий</div>' : '',
    `<div>${confidence(t.confidence)}</div>`,
    `<div><a href="${esc(sourceLink(o))}" target="_blank" rel="noopener noreferrer">джерело: t.me/${esc(o.channel)}/${o.messageId}</a></div>`,
    `<div class="pp-note">дані з відкритих джерел</div>`,
  ];
  return lines.filter(Boolean).join('');
}

function alertLine(a: Alert, now: number): string {
  const since = `з ${hhmm(a.startedAt)} (${minutesAgo(a.startedAt, now).replace(' тому', '')})`;
  if (a.level === 'raion') return `Тривога в районі ${since}`;
  if (a.level === 'hromada') return `Тривога в окремих громадах ${since}`;
  return a.severity === 'full' ? `Тривога по всій області ${since}` : `Часткова тривога ${since}`;
}

/** Tooltip for a region polygon. */
export function regionPopupHtml(
  name: string,
  oblast: string,
  state: RegionAlertState | undefined,
  now: number,
): string {
  const head = `<div class="pp-title">${esc(name)}</div>`;
  const sub = name === oblastName(oblast) ? '' : `<div>${esc(oblastName(oblast))}</div>`;
  if (!state || state.alerts.length === 0) return head + sub + '<div>Тривоги немає</div>';
  const lines = state.alerts.map((a) => `<div>${esc(alertLine(a, now))}</div>`).join('');
  const areas = alertAreas(state);
  const areaHtml = areas.length
    ? `<div class="pp-areas">Під тривогою: ${areas.map(esc).join(', ')}</div>`
    : '';
  return head + sub + lines + areaHtml;
}
