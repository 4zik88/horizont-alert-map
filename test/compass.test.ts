import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { extractCourse } from '../src/parser/compass.js';

describe('extractCourse', () => {
  test('reads a stated compass course', () => {
    assert.equal(extractCourse('Ударні БпЛА на півдні Сумщини, курс західний.'), 270);
    assert.equal(extractCourse('БпЛА курс північний'), 0);
    assert.equal(extractCourse('рухається у південному напрямку'), 180);
    assert.equal(extractCourse('Реактивний БпЛА північно-східним курсом'), 45);
    assert.equal(extractCourse('заходять з південно-західним курсом'), 225);
  });

  // "північно-східний" must not be read as plain "північ" — a 45 degree error.
  test('prefers compound directions over their components', () => {
    assert.equal(extractCourse('курс північно-західний'), 315);
    assert.notEqual(extractCourse('курс північно-західний'), 0);
  });

  // A location is not a heading. "на півночі Чернігівщини" says where the target is,
  // and reading it as a course would point the map arrow the wrong way.
  test('ignores directions that are locations, not courses', () => {
    assert.equal(extractCourse('БпЛА на півночі Чернігівщини'), null);
    assert.equal(extractCourse('Ударний БпЛА над містом'), null);
    assert.equal(extractCourse(''), null);
  });
});
