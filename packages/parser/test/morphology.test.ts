import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { generateForms, normalise } from '../src/morphology.js';

const has = (name: string, form: string) =>
  assert.ok(
    generateForms(name).includes(normalise(form)),
    `${name} should generate "${form}" (got: ${generateForms(name).slice(0, 12).join(', ')})`,
  );

describe('normalise', () => {
  test('unifies apostrophes and case', () => {
    assert.equal(normalise("Кам’янка"), "кам'янка");
    assert.equal(normalise("Кам'янка"), "кам'янка");
    assert.equal(normalise('  Нова   Каховка '), 'нова каховка');
  });
});

describe('generateForms', () => {
  // These are the exact case forms the channels actually use.
  test('feminine -а: accusative and genitive', () => {
    has('Охтирка', 'Охтирку');  // курсом на Охтирку
    has('Охтирка', 'Охтирки');  // в напрямку Охтирки
    has('Охтирка', 'Охтирці');  // к -> ц before -і
    has('Полтава', 'Полтаву');
    has('Журівка', 'Журівку');
    has('Шпола', 'Шполи');
  });

  test('consonant-final masculine keeps the nominative for accusative', () => {
    has('Богодухів', 'Богодухів'); // "на Богодухів" — acc = nom for inanimates
    has('Богодухів', 'Богодухова');
    has('Львів', 'Львова');
    has('Київ', 'Києва');
    has('Павлоград', 'Павлоградом'); // над Павлоградом
  });

  // The bug this caught: soft-sign endings were unhandled, so "Ковеля" never matched.
  test('soft-sign masculine', () => {
    has('Ковель', 'Ковеля');
    has('Тернопіль', 'Тернополя'); // closed-syllable і -> о
    has('Бориспіль', 'Борисполя');
  });

  test('neuter and plural', () => {
    has('Краснопілля', 'Краснопілля');
    has('Суми', 'Сум');
    has('Прилуки', 'Прилук');
    has('Чернівці', 'Чернівців');
  });

  test('adjectival names', () => {
    has('Зміїний', 'Зміїний');
    has('Рівне', 'Рівного');
  });

  test('multi-word names inflect every part', () => {
    has('Липова Долина', 'Липову Долину'); // БпЛА курсом на Липову Долину
    has('Нова Каховка', 'Нової Каховки');
    has('Кам’янець-Подільський', 'Кам’янець-Подільського');
  });

  test('always includes the bare nominative and stays bounded', () => {
    const forms = generateForms('Нова Каховка');
    assert.ok(forms.includes('нова каховка'));
    assert.ok(forms.length < 500, 'form explosion must stay bounded');
    assert.deepEqual(generateForms(''), []);
  });
});
