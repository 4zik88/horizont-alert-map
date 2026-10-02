import type { DesiredAlert } from '@horizont/db';
import { raionsOf } from '@horizont/geo/node';
import type { AlertLevel } from '../alerts/client.js';

/**
 * The alert feed's state, as the intervals the map paints.
 *
 * - An oblast-wide alert (`full`) is one red oblast.
 * - A partial alert names raions and/or hromadas. Each named raion is painted red
 *   on its own polygon; the names that are not raions (hromadas, cities) have no
 *   polygon, so they become one yellow oblast-level entry listing them.
 * - A partial alert that names nothing (a provider without area detail) is a yellow
 *   oblast: something in it is warned, and we cannot say what.
 *
 * Painting a whole oblast red because one hromada is warned is the overstatement the
 * raion work set out to remove; painting nothing would hide a real alert.
 */
export function desiredAlerts(
  levels: ReadonlyMap<string, AlertLevel>,
  areas: ReadonlyMap<string, readonly string[]>,
): DesiredAlert[] {
  const out: DesiredAlert[] = [];

  for (const [oblast, level] of levels) {
    if (level === 'none') continue;

    if (level === 'full') {
      out.push({ regionId: `oblast:${oblast}`, oblast, level: 'oblast', severity: 'full', areas: [] });
      continue;
    }

    const named = [...new Set(areas.get(oblast) ?? [])];
    const raions = raionsOf(oblast);
    const raionKeys = new Set(raions.map((r) => r.match));

    for (const name of named) {
      if (raionKeys.has(name)) {
        out.push({ regionId: `raion:${oblast}:${name}`, oblast, level: 'raion', severity: 'full', areas: [] });
      }
    }

    const rest = named.filter((n) => !raionKeys.has(n)).sort();
    if (rest.length > 0) {
      out.push({ regionId: `oblast:${oblast}`, oblast, level: 'hromada', severity: 'partial', areas: rest });
    } else if (named.length === 0) {
      out.push({ regionId: `oblast:${oblast}`, oblast, level: 'oblast', severity: 'partial', areas: [] });
    }
  }

  return out;
}
