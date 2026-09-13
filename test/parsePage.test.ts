import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, describe } from 'node:test';
import { normaliseText, parsePage } from '../src/telegram/parsePage.js';

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');

const kpszsu = parsePage(fixture('kpszsu.html'), 'kpszsu');
const kozak = parsePage(fixture('kozakchornobay.html'), 'KozakChornobay');
const sector = parsePage(fixture('sectorv666.html'), 'sectorv666');

describe('parsePage', () => {
  test('extracts every message from each channel page', () => {
    for (const [name, messages] of [
      ['kpszsu', kpszsu],
      ['kozakchornobay', kozak],
      ['sectorv666', sector],
    ] as const) {
      assert.equal(messages.length, 20, `${name} should yield 20 messages`);
      assert.ok(
        messages.every((m) => m.messageId > 0 && m.postedAt > 0 && m.textHtml !== null),
        `${name} messages should all have an id, a timestamp and a body`,
      );
    }
  });

  test('normalises the channel name and returns messages in id order', () => {
    assert.ok(kozak.every((m) => m.channel === 'kozakchornobay'));
    const ids = sector.map((m) => m.messageId);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  });

  // Regression test for the gotcha that motivates the whole module: reply previews
  // reuse `tgme_widget_message_text`. 58360 quotes 58359, and the quoted text reads
  // exactly like a live target report — if it leaked into 58360, step 2 would emit a
  // phantom duplicate target.
  test('attributes quoted reply text to the original message only', () => {
    const quoted = '2 реактивних на Черкащину, Шпола';

    const original = sector.find((m) => m.messageId === 58359);
    const quoter = sector.find((m) => m.messageId === 58360);

    assert.equal(original?.text, quoted, '58359 is the original and keeps its text');
    assert.ok(
      !quoter?.text.includes(quoted),
      '58360 quotes 58359 — the quote must not be attributed to it',
    );

    assert.ok(
      sector.every((m) => !m.text.includes('Друзі, ви знаєте')),
      'no message should absorb the reply preview quoted by 58351',
    );
  });

  // Reactions live in a sibling div; a regex over the message block would swallow them.
  test('excludes the reactions bar from message text', () => {
    const summary = kpszsu.find((m) => m.messageId === 78115);
    assert.ok(summary);
    assert.ok(summary.text.endsWith('Не ігноруйте тривогу!'));
    assert.ok(!/\d{3}👍/u.test(summary.text), 'reaction counts must not leak into text');
  });

  test('decodes HTML entities and keeps paragraph breaks', () => {
    const summary = kpszsu.find((m) => m.messageId === 78115);
    assert.ok(summary?.text.includes('"Бандероль/Дань-Т"'), '&quot; should be decoded');
    assert.ok(summary?.text.includes('\n\n'), 'paragraph breaks should survive');
    assert.ok(!summary?.text.includes('\n\n\n'), 'blank runs should collapse to one');
  });

  // Step 2 segments multi-target messages by line under a sticky oblast heading, so
  // losing <br/> structure here would silently destroy the parser's input.
  test('preserves the one-target-per-line structure step 2 depends on', () => {
    const grouped = sector.find((m) => m.messageId === 58367);
    assert.deepEqual(grouped?.text.split('\n'), [
      'Сумщина:',
      'Реактивний БпЛА курсом на Краснопілля',
      'Реактивний БпЛА курсом на Кириківку',
      'БпЛА курсом на Охтирку',
      '',
      'Харківщина:',
      'БпЛА курсом на Богодухів',
      '',
      'Дніпропетровщина:',
      'БпЛА курсом на Васильківку',
    ]);
  });

  test('renders a custom tg-emoji exactly once', () => {
    const message = kpszsu.find((m) => m.messageId === 78128);
    assert.equal(message?.text, '🛵 Сумщина: БпЛА в напрямку Охтирки з північного сходу.');
  });

  // Guards against a local-timezone-dependent parse.
  test('reads posted_at as absolute UTC', () => {
    const message = kpszsu.find((m) => m.messageId === 78115);
    assert.equal(message?.postedAt, Date.parse('2026-09-13T15:36:10.000Z'));
  });

  // Deleted posts leave permanent holes; nothing downstream may treat a missing id as
  // evidence that we skipped a message.
  test('handles non-contiguous ids left by deleted posts', () => {
    const ids = sector.map((m) => m.messageId);
    assert.equal(ids[0], 58348);
    assert.equal(ids.at(-1), 58368);
    assert.ok(!ids.includes(58352), '58352 was deleted and is absent from the page');
    assert.equal(ids.length, 20, 'the page still carries a full 20 messages');
  });

  test('ignores blocks belonging to a different channel', () => {
    assert.deepEqual(parsePage(fixture('sectorv666.html'), 'kpszsu'), []);
  });

  test('returns nothing for markup it does not recognise', () => {
    assert.deepEqual(parsePage('<html><body><p>nope</p></body></html>', 'kpszsu'), []);
  });
});

describe('normaliseText', () => {
  test('converts breaks, trims lines and collapses blank runs', () => {
    assert.equal(normaliseText('a<br/>b<br><br><br/>c'), 'a\nb\n\nc');
    assert.equal(normaliseText('  padded  <br/>  line  '), 'padded\nline');
    assert.equal(normaliseText('&amp; &lt;tag&gt; &quot;q&quot;'), '& <tag> "q"');
    assert.equal(normaliseText(''), '');
  });
});
