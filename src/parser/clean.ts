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

export function stripBoilerplate(text: string): string {
  return text
    .split('\n')
    .filter((line) => !BOILERPLATE.some((re) => re.test(line)))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
