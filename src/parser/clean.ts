/**
 * Channel boilerplate removal.
 *
 * Every @KozakChornobay post ends with "Підписатися на Козака Чорнобая🔱". Left in
 * place it is the single largest source of false destinations — the trailing "на
 * <name>" parses as a course heading, and it appeared 469 times in a 1,497-message
 * corpus, more than ten times the next most common phrase.
 */
const BOILERPLATE = [
  /підпис(атися|уйтесь|атись|ка)/iu,
  /^\s*@[\w_]+\s*$/u,
  /t\.me\//iu,
  /наш(і)?\s+(бот|канал|чат)/iu,
  /надіслати\s+новину/iu,
  /повідомити\s+про/iu,
  /^\s*реклама\b/iu,
  /бот\s+для\s+зв'?язку/iu,
];

/*
 * A fundraising appeal, which is never a target report.
 *
 * @kozakchornobay asks for coffee money between warnings, and one of those posts
 * read: "Намагаюсь оперативно сповістити про кожну ціль з повітря з Одеси". Every
 * line-level guard passed it — it is long, so the shorthand rule does not apply, and
 * it contains "ціль", so the untyped-evidence rule accepts it. The result was a
 * target sitting on Odesa with a real position, able to wake anyone within 40 km of
 * it at four in the morning.
 *
 * The tell is not in that sentence; it is in the post around it. A message carrying a
 * card number or a payment handle is asking for money, whatever else it says. Matched
 * on the whole message rather than per line, because the sentence that produced the
 * false target carries no payment word of its own.
 *
 * Deliberately narrow: a bare "моно" would catch "монолітний", so only the banks are
 * named. A real warning has never contained a sixteen-digit number.
 */
const FUNDRAISING = [
  /(?<!\d)\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}(?!\d)/u,
  /privat\s?bank|приватбанк/iu,
  /pay\s?pal/iu,
  /монобанк|карт(?:а|ка|ки|ку)\s+моно/iu,
  /patreon|патреон/iu,
  /send\.monobank|jar\/|банк[аи]?\s+для\s+збор/iu,
];

export function isFundraising(text: string): boolean {
  return FUNDRAISING.some((re) => re.test(text));
}

export function stripBoilerplate(text: string): string {
  return text
    .split('\n')
    .filter((line) => !BOILERPLATE.some((re) => re.test(line)))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
