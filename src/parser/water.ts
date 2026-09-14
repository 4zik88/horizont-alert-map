import { normalise } from './morphology.js';

/**
 * Seas and large reservoirs, as direction anchors.
 *
 * The gazetteer holds settlements only, so "Ударний БпЛА на Херсонщині у напрямку
 * Чорного моря" and "БпЛА з акваторії Чорного моря - на південь Одещини" resolved to
 * nothing on the water side. Both lines state a real direction — one outbound to the
 * sea, one inbound from it — and dropping the water end threw that away.
 *
 * The positions are deliberately coarse: a sea is not a point, and these exist to
 * give a bearing, never to place a marker precisely. They resolve as `oblast` kind
 * for exactly that reason, so a named settlement always outranks them.
 */
export interface WaterBody {
  name: string;
  lat: number;
  lon: number;
  /** Inflected forms as the channels write them, normalised. */
  forms: string[];
}

export const WATER_BODIES: WaterBody[] = [
  {
    // Centred on the north-western shelf, the part of the sea these reports mean —
    // not the basin centre, which sits off the Turkish coast and would put every
    // Odesa-bound bearing at an angle nobody would recognise.
    name: 'Чорне море',
    lat: 44.8,
    lon: 31.0,
    forms: [
      'чорне море', 'чорного моря', 'чорному морі', 'чорним морем',
      'чорноморська акваторія', 'акваторія чорного моря',
    ],
  },
  {
    name: 'Азовське море',
    lat: 46.3,
    lon: 36.6,
    forms: [
      'азовське море', 'азовського моря', 'азовському морі', 'азовським морем',
      'акваторія азовського моря',
    ],
  },
  {
    name: 'Кременчуцьке водосховище',
    lat: 49.3,
    lon: 32.6,
    forms: [
      'кременчуцьке водосховище', 'кременчуцького водосховища',
      'кременчуцькому водосховищі',
    ],
  },
  {
    name: 'Київське водосховище',
    lat: 51.0,
    lon: 30.3,
    forms: [
      'київське водосховище', 'київського водосховища', 'київському водосховищі',
    ],
  },
  {
    name: 'Каховське водосховище',
    lat: 47.4,
    lon: 34.0,
    forms: [
      'каховське водосховище', 'каховського водосховища',
      'каховському водосховищі',
    ],
  },
];

const BY_FORM = new Map<string, WaterBody>();
for (const body of WATER_BODIES) {
  for (const form of body.forms) BY_FORM.set(normalise(form), body);
}

/**
 * Match a phrase against the water bodies.
 *
 * Matches the longest leading run of words that names one, so "Чорного моря" is
 * found inside "Чорного моря рухаються" without the trailing words breaking it.
 */
export function matchWater(phrase: string): WaterBody | undefined {
  // Trailing punctuation is part of the word for `normalise`, and "Чорного моря."
  // at the end of a sentence is the common case rather than the exception.
  const words = normalise(phrase)
    .split(/\s+/)
    .map((word) => word.replace(/^[«"(]+|[»".,;:!?)]+$/g, ''))
    .filter(Boolean);
  for (let take = Math.min(words.length, 3); take >= 2; take--) {
    const hit = BY_FORM.get(words.slice(0, take).join(' '));
    if (hit) return hit;
  }
  return undefined;
}
