import { generateForms, normalise } from './morphology.js';

/**
 * Oblast lexicon.
 *
 * Channels head a block with a colloquial oblast name ("Сумщина:", "Одещина") and
 * the targets below it inherit that heading, so recognising these is what makes
 * settlement disambiguation possible at all — 511 of the 5,757 gazetteer names are
 * ambiguous nationally, but far fewer within one oblast.
 *
 * `centre` is the administrative centre, used as a coarse fallback position when a
 * message names only the oblast and no settlement.
 */
export interface Oblast {
  key: string;
  name: string;
  /** Colloquial and adjectival variants, before morphological expansion. */
  aliases: string[];
  centreLat: number;
  centreLon: number;
  /**
   * Number of raions the oblast contains, from `seed/raions.geojson`.
   *
   * This is what separates the yellow level from the red one on the public alert
   * feed: an air-raid alert naming every raion of an oblast is an oblast-wide
   * (red) alert, one naming a few is the partial (yellow) level. A city region
   * has none, so any alert there is oblast-wide by definition.
   */
  raions: number;
  /**
   * Kyiv is an oblast-level unit *and* a city. Alerts treat it as a region, but a
   * message saying "у напрямку Києва" means the city — so resolution prefers the
   * gazetteer settlement and only falls back to the region.
   */
  cityRegion?: true;
}

export const OBLASTS: Oblast[] = [
  { key: 'vinnytska', name: 'Вінницька', aliases: ['Вінниччина', 'Вінницька'], centreLat: 49.2331, centreLon: 28.4682, raions: 6 },
  { key: 'volynska', name: 'Волинська', aliases: ['Волинь', 'Волинська'], centreLat: 50.7472, centreLon: 25.3254, raions: 4 },
  { key: 'dnipropetrovska', name: 'Дніпропетровська', aliases: ['Дніпропетровщина', 'Січеславщина', 'Дніпропетровська'], centreLat: 48.4647, centreLon: 35.0462, raions: 7 },
  { key: 'donetska', name: 'Донецька', aliases: ['Донеччина', 'Донецька'], centreLat: 48.0159, centreLon: 37.8029, raions: 8 },
  { key: 'zhytomyrska', name: 'Житомирська', aliases: ['Житомирщина', 'Житомирська'], centreLat: 50.2547, centreLon: 28.6587, raions: 4 },
  { key: 'zakarpatska', name: 'Закарпатська', aliases: ['Закарпаття', 'Закарпатська'], centreLat: 48.6208, centreLon: 22.2879, raions: 6 },
  { key: 'zaporizka', name: 'Запорізька', aliases: ['Запоріжжя', 'Запорізька'], centreLat: 47.8388, centreLon: 35.1396, raions: 5 },
  { key: 'ivano-frankivska', name: 'Івано-Франківська', aliases: ['Прикарпаття', 'Івано-Франківщина', 'Івано-Франківська'], centreLat: 48.9226, centreLon: 24.7111, raions: 6 },
  { key: 'kyivska', name: 'Київська', aliases: ['Київщина', 'Київська'], centreLat: 50.4501, centreLon: 30.5234, raions: 7 },
  { key: 'kirovohradska', name: 'Кіровоградська', aliases: ['Кіровоградщина', 'Кропивниччина', 'Кіровоградська'], centreLat: 48.5079, centreLon: 32.2623, raions: 4 },
  { key: 'luhanska', name: 'Луганська', aliases: ['Луганщина', 'Луганська'], centreLat: 48.574, centreLon: 39.3078, raions: 8 },
  { key: 'lvivska', name: 'Львівська', aliases: ['Львівщина', 'Львівська'], centreLat: 49.8397, centreLon: 24.0297, raions: 7 },
  { key: 'mykolaivska', name: 'Миколаївська', aliases: ['Миколаївщина', 'Миколаївська'], centreLat: 46.975, centreLon: 31.9946, raions: 4 },
  { key: 'odeska', name: 'Одеська', aliases: ['Одещина', 'Одеська'], centreLat: 46.4825, centreLon: 30.7233, raions: 7 },
  { key: 'poltavska', name: 'Полтавська', aliases: ['Полтавщина', 'Полтавська'], centreLat: 49.5883, centreLon: 34.5514, raions: 4 },
  { key: 'rivnenska', name: 'Рівненська', aliases: ['Рівненщина', 'Рівненська'], centreLat: 50.6199, centreLon: 26.2516, raions: 4 },
  { key: 'sumska', name: 'Сумська', aliases: ['Сумщина', 'Сумська'], centreLat: 50.9077, centreLon: 34.7981, raions: 5 },
  { key: 'ternopilska', name: 'Тернопільська', aliases: ['Тернопільщина', 'Тернопільська'], centreLat: 49.5535, centreLon: 25.5948, raions: 3 },
  { key: 'kharkivska', name: 'Харківська', aliases: ['Харківщина', 'Харківська'], centreLat: 49.9935, centreLon: 36.2304, raions: 7 },
  { key: 'khersonska', name: 'Херсонська', aliases: ['Херсонщина', 'Херсонська'], centreLat: 46.6354, centreLon: 32.6169, raions: 5 },
  { key: 'khmelnytska', name: 'Хмельницька', aliases: ['Хмельниччина', 'Хмельницька'], centreLat: 49.4229, centreLon: 26.9871, raions: 3 },
  { key: 'cherkaska', name: 'Черкаська', aliases: ['Черкащина', 'Черкаська'], centreLat: 49.4444, centreLon: 32.0598, raions: 4 },
  { key: 'chernivetska', name: 'Чернівецька', aliases: ['Буковина', 'Чернівеччина', 'Чернівецька'], centreLat: 48.2917, centreLon: 25.9352, raions: 3 },
  { key: 'chernihivska', name: 'Чернігівська', aliases: ['Чернігівщина', 'Чернігівська'], centreLat: 51.4982, centreLon: 31.2893, raions: 5 },
  { key: 'krym', name: 'Крим', aliases: ['Крим', 'Кримський'], centreLat: 45.3, centreLon: 34.4, raions: 35 },
  { key: 'kyiv', name: 'Київ', aliases: ['Київ'], centreLat: 50.4501, centreLon: 30.5234, cityRegion: true, raions: 0 },
];

/** KATOTTH / KOATUU codes start with a two-digit oblast code — how gazetteer rows get an oblast. */
export const CODE_TO_OBLAST: Record<string, string> = {
  '01': 'krym', '05': 'vinnytska', '07': 'volynska', '12': 'dnipropetrovska', '14': 'donetska',
  '18': 'zhytomyrska', '21': 'zakarpatska', '23': 'zaporizka', '26': 'ivano-frankivska',
  '32': 'kyivska', '35': 'kirovohradska', '44': 'luhanska', '46': 'lvivska', '48': 'mykolaivska',
  '51': 'odeska', '53': 'poltavska', '56': 'rivnenska', '59': 'sumska', '61': 'ternopilska',
  '63': 'kharkivska', '65': 'khersonska', '68': 'khmelnytska', '71': 'cherkaska',
  '73': 'chernivetska', '74': 'chernihivska', '80': 'kyiv', '85': 'krym',
};

const LOOKUP = new Map<string, Oblast>();
for (const oblast of OBLASTS) {
  for (const alias of oblast.aliases) {
    for (const form of generateForms(alias)) {
      // First writer wins: aliases are listed most-distinctive first.
      if (!LOOKUP.has(form)) LOOKUP.set(form, oblast);
    }
  }
}

/** Resolve a token such as "Сумщині" or "Харківщину" to its oblast. */
export function matchOblast(token: string): Oblast | undefined {
  return LOOKUP.get(normalise(token));
}

export function oblastByKey(key: string): Oblast | undefined {
  return OBLASTS.find((o) => o.key === key);
}
