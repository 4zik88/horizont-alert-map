import { HISTORY_MS, type SourceStatus } from '@horizont/contract';
import { hhmm } from './format.js';

export interface SourcesSummary {
  level: 'ok' | 'warn' | 'bad';
  short: string;
  detail: string;
}

const SOURCE_NAME: Record<string, string> = {
  kpszsu: 'Повітряні сили (@kpszsu)',
  kozakchornobay: '@KozakChornobay',
  sectorv666: '@sectorv666',
  'alerts.in.ua': 'alerts.in.ua',
};

export function sourceName(s: string): string {
  return SOURCE_NAME[s] ?? s;
}

/** One pill for source health: any unhealthy source is a visible warning. */
export function sourcesSummary(sources: SourceStatus[]): SourcesSummary {
  if (sources.length === 0) {
    return { level: 'warn', short: 'джерела: ?', detail: 'Стан джерел невідомий' };
  }
  const bad = sources.filter((s) => !s.healthy);
  const lines = sources.map((s) => {
    const when = s.lastSuccessAt ? `востаннє ${hhmm(s.lastSuccessAt)}` : 'ще не відповідало';
    return `${sourceName(s.source)}: ${s.healthy ? 'працює' : 'збій'} (${when})`;
  });
  if (bad.length === 0) {
    return { level: 'ok', short: 'джерела ок', detail: lines.join('\n') };
  }
  return {
    level: bad.length === sources.length ? 'bad' : 'warn',
    short: bad.length === 1 ? `збій: ${bad[0]!.source}` : `збій джерел: ${bad.length}`,
    detail: lines.join('\n'),
  };
}

/** The timeline slider counts minutes over the last 3 h; the right end is "now". */
export const SLIDER_MAX = Math.round(HISTORY_MS / 60_000);

export function sliderToTime(value: number, now: number): number {
  const v = Math.min(SLIDER_MAX, Math.max(0, Math.round(value)));
  return now - (SLIDER_MAX - v) * 60_000;
}

export function timeToSlider(at: number, now: number): number {
  const v = SLIDER_MAX - Math.round((now - at) / 60_000);
  return Math.min(SLIDER_MAX, Math.max(0, v));
}
