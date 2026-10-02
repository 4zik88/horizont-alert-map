import type { Observation, TargetType } from '@horizont/contract';

/** Everything on screen is Kyiv wall-clock time, wherever the phone thinks it is. */
const HHMM = new Intl.DateTimeFormat('uk-UA', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Europe/Kyiv',
});

export function hhmm(ms: number): string {
  return HHMM.format(new Date(ms));
}

export const TYPE_LABEL: Record<TargetType, string> = {
  uav: 'Шахед / БпЛА',
  jet_uav: 'Реактивний БпЛА',
  cruise: 'Крилата ракета',
  ballistic: 'Балістика',
  kab: 'КАБ',
  aviation: 'Авіація',
  recon: 'Розвідувальний БпЛА',
  unknown: 'Невідома ціль',
};

/** Short form for lists and labels. */
export const TYPE_SHORT: Record<TargetType, string> = {
  uav: 'Шахед',
  jet_uav: 'Реакт. БпЛА',
  cruise: 'Крилата',
  ballistic: 'Балістика',
  kab: 'КАБ',
  aviation: 'Авіація',
  recon: 'Розвідник',
  unknown: 'Ціль',
};

export function typeWithCount(type: TargetType, count: number): string {
  return count > 1 ? `${TYPE_SHORT[type]} ×${count}` : TYPE_SHORT[type];
}

export function minutesAgo(at: number, now: number): string {
  const min = Math.max(0, Math.floor((now - at) / 60_000));
  if (min < 1) return 'щойно';
  if (min < 60) return `${min} хв тому`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} год тому` : `${h} год ${m} хв тому`;
}

export function confidence(c: number): string {
  const pct = Math.round(Math.min(1, Math.max(0, c)) * 100);
  return `впевненість ${pct}%`;
}

/** Rounded to something a reader can use; never more precise than the data. */
export function km(value: number): string {
  if (value < 1) return '<1';
  if (value < 10) return String(Math.round(value));
  return String(Math.round(value / 5) * 5);
}

export function etaMinutes(value: number): string {
  return String(Math.max(1, Math.round(value)));
}

/** Link back to the exact message the observation was parsed from. */
export function sourceLink(o: Pick<Observation, 'channel' | 'messageId'>): string {
  return `https://t.me/${encodeURIComponent(o.channel)}/${o.messageId}`;
}

export const OBLAST_NAME: Record<string, string> = {
  vinnytska: 'Вінницька обл.',
  volynska: 'Волинська обл.',
  dnipropetrovska: 'Дніпропетровська обл.',
  donetska: 'Донецька обл.',
  zhytomyrska: 'Житомирська обл.',
  zakarpatska: 'Закарпатська обл.',
  zaporizka: 'Запорізька обл.',
  'ivano-frankivska': 'Івано-Франківська обл.',
  kyivska: 'Київська обл.',
  kirovohradska: 'Кіровоградська обл.',
  luhanska: 'Луганська обл.',
  lvivska: 'Львівська обл.',
  mykolaivska: 'Миколаївська обл.',
  odeska: 'Одеська обл.',
  poltavska: 'Полтавська обл.',
  rivnenska: 'Рівненська обл.',
  sumska: 'Сумська обл.',
  ternopilska: 'Тернопільська обл.',
  kharkivska: 'Харківська обл.',
  khersonska: 'Херсонська обл.',
  khmelnytska: 'Хмельницька обл.',
  cherkaska: 'Черкаська обл.',
  chernivetska: 'Чернівецька обл.',
  chernihivska: 'Чернігівська обл.',
  krym: 'АР Крим',
  kyiv: 'м. Київ',
};

export function oblastName(key: string): string {
  return OBLAST_NAME[key] ?? key;
}

/** Escape text before it goes into innerHTML. Channel text is untrusted. */
export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
