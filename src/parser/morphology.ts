/**
 * Ukrainian toponym morphology.
 *
 * Channels never write a settlement in the nominative — they write "курсом на
 * Охтирку" (accusative), "в напрямку Охтирки" (genitive), "над Павлоградом"
 * (instrumental). Matching raw tokens against a nominative gazetteer therefore
 * finds almost nothing.
 *
 * Rather than analyse a token's case, we generate a *superset* of plausible
 * inflected forms for every dictionary entry and index all of them. Matching is
 * then an exact lookup on a normalised token.
 *
 * Over-generation is deliberate and safe: a form that is not real Ukrainian only
 * matters if it collides with a different real toponym, which is rare and settled
 * by the same ranking that resolves genuine name collisions. Under-generation, by
 * contrast, silently loses targets — so the rules below lean permissive.
 */

const APOSTROPHES = /[’'`´ʼ‘]/g;

/** Lowercase, unify apostrophes, collapse whitespace. Applied to both sides of a lookup. */
export function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(APOSTROPHES, "'")
    .replace(/́/g, '') // combining acute accent, occasionally present in OSM names
    .replace(/\s+/g, ' ')
    .trim();
}

/** Consonant mutation before the -і ending: Охтирка -> Охтирці, Волга -> Волзі. */
const SOFTENING: Record<string, string> = { к: 'ц', г: 'з', х: 'с' };

function inflectWord(word: string): Set<string> {
  const out = new Set<string>([word]);
  const add = (...values: string[]) => values.forEach((v) => v.length > 1 && out.add(v));

  const stem = word.slice(0, -1);
  const last = word.slice(-1);

  if (last === 'а') {
    // Feminine: Охтирка, Полтава, Журівка.
    add(stem + 'и', stem + 'і', stem + 'у', stem + 'ою', stem + 'ам', stem + 'ах');
    // Adjectival feminine, as in the first word of "Нова Каховка" -> "Нової Каховки".
    add(stem + 'ої', stem + 'ій', stem + 'ою');
    const mutated = SOFTENING[stem.slice(-1)];
    if (mutated) add(stem.slice(0, -1) + mutated + 'і');
  } else if (last === 'я') {
    // Feminine/neuter soft: Краснопілля, Наталія.
    add(stem + 'ї', stem + 'і', stem + 'ю', stem + 'ею', stem + 'єю', stem + 'ям');
  } else if (last === 'о') {
    // Neuter: Ніжино-type, Рівно-type.
    add(stem + 'а', stem + 'у', stem + 'ом', stem + 'і');
  } else if (last === 'е') {
    // Neuter / adjectival: Рівне, Липове.
    add(stem + 'я', stem + 'ого', stem + 'ому', stem + 'им');
  } else if (last === 'и') {
    // Plural: Суми -> Сум, Прилуки -> Прилук, Ромни -> Ромен.
    add(stem, stem + 'ів', stem + 'ам', stem + 'ами', stem + 'ах');
  } else if (last === 'і') {
    // Plural soft: Чернівці -> Чернівців.
    add(stem + 'ів', stem + 'ям', stem + 'ями', stem + 'ях');
  } else if (word.endsWith('ий') || word.endsWith('ій')) {
    // Adjectival masculine: Хмельницький -> Хмельницького, Зміїний -> Зміїного.
    const base = word.slice(0, -2);
    add(base + 'ого', base + 'ому', base + 'им', base + 'ім', base + 'ий', base + 'ій');

    /*
     * Not every -ий name is an adjective: "Стрий" is a noun and declines Стрию,
     * Стрия, Стриєм. Telling the two apart by the stem does not work — "Стрий" and
     * the genuinely adjectival "Старий" both leave a three-letter stem ending in
     * -р — so both paradigms are generated, which is what this module does
     * everywhere else.
     */
    const noun = word.slice(0, -1);
    add(noun + 'ю', noun + 'я', noun + 'єм', noun + 'ї', noun + 'єві');
  } else {
    // Consonant-final masculine: accusative equals nominative for inanimates,
    // which is why "на Богодухів" needs no change — but the obliques do.
    add(word + 'а', word + 'у', word + 'ом', word + 'і', word + 'е', word + 'ів');

    if (word.endsWith('їв')) {
      // Київ -> Києва, Миколаїв -> Миколаєва
      const base = word.slice(0, -2);
      add(base + 'єва', base + 'єву', base + 'євом', base + 'єві');
    } else if (word.endsWith('ів')) {
      // Богодухів -> Богодухова, Львів -> Львова
      const base = word.slice(0, -2);
      add(base + 'ова', base + 'ову', base + 'овом', base + 'ові');
    } else if (word.endsWith('ь')) {
      // Soft-sign masculine: Ковель -> Ковеля, Тернопіль -> Тернополя.
      const base = word.slice(0, -1);
      add(base + 'я', base + 'ю', base + 'ем', base + 'і', base + 'еві');
      if (word.endsWith('іль')) {
        // Closed-syllable і -> о alternation: Бориспіль -> Борисполя.
        const open = word.slice(0, -3) + 'ол';
        add(open + 'я', open + 'ю', open + 'ем', open + 'і');
      }
    } else if (word.endsWith('ець')) {
      // Кам'янець -> Кам'янця
      const base = word.slice(0, -3);
      add(base + 'ця', base + 'цю', base + 'цем', base + 'ці');
    } else if (/і[бвгджзклмнпрстфхцчш]+$/u.test(word)) {
      // Closed-syllable і -> о alternation: Ріг -> Рогу, Стрий-type stems.
      // Without this, "Кривого Рогу" fails to match and the lookup falls back to the
      // first word alone, which collided with an unrelated village called "Криве".
      const opened = word.replace(/і([бвгджзклмнпрстфхцчш]+)$/u, 'о$1');
      add(opened + 'а', opened + 'у', opened + 'ом', opened + 'і');
    } else if (word.endsWith('й')) {
      // Soft masculine in -й: Джанкой -> Джанкоя, Джанкою. The generic consonant
      // rule above produces "Джанкойа", which is not a word anyone writes.
      const base = word.slice(0, -1);
      add(base + 'я', base + 'ю', base + 'єм', base + 'ї', base + 'єві');
    } else if (word.endsWith('ок')) {
      // Лозок -> Лозка (fleeting vowel)
      const base = word.slice(0, -2);
      add(base + 'ка', base + 'ку', base + 'ком', base + 'ці');
    }
  }

  return out;
}

const MAX_FORMS = 400;

/**
 * All lookup keys for one dictionary entry.
 *
 * Multi-word names ("Нова Каховка", "Кам'янець-Подільський") inflect every part,
 * so the cartesian product of per-word forms is generated — bounded, because these
 * names are two or three words at most.
 */
export function generateForms(name: string): string[] {
  const normalised = normalise(name);
  if (normalised.length === 0) return [];

  const separators = /([ -])/;
  const parts = normalised.split(separators);

  let combinations: string[] = [''];
  for (const part of parts) {
    if (part === ' ' || part === '-') {
      combinations = combinations.map((c) => c + part);
      continue;
    }

    const variants = [...inflectWord(part)];
    const next: string[] = [];
    for (const prefix of combinations) {
      for (const variant of variants) {
        next.push(prefix + variant);
        if (next.length >= MAX_FORMS) break;
      }
      if (next.length >= MAX_FORMS) break;
    }
    combinations = next;
  }

  // The bare nominative must always be present even if the cap truncated the rest.
  return [...new Set([normalised, ...combinations])].filter((f) => f.length > 1);
}
