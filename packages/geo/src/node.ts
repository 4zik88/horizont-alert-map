import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export * from './raions.js';

/** Absolute path of a file shipped in this package's data/ folder. */
export function geoDataPath(name: 'gazetteer.json' | 'raions.geojson' | 'map-regions.geojson'): string {
  return resolve(join(dirname(fileURLToPath(import.meta.url)), '..', 'data', name));
}
