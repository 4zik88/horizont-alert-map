import { parse, type HTMLElement } from 'node-html-parser';
import type { ParsedMessage } from './types.js';

/**
 * Extracts messages from a t.me/s/<channel> preview page.
 *
 * Pure by design — no DB, no network, no clock — which is what makes it unit-testable
 * against saved fixtures and what step 2's `parseTargets(text)` will sit beside.
 *
 * Four things about Telegram's markup that this has to get right (all verified
 * against live pages):
 *
 *  1. Reply previews reuse the `tgme_widget_message_text` class but carry
 *     `js-message_reply_text` instead of `js-message_text`. Selecting the latter,
 *     scoped per message block, keeps quoted text from another post out of a live
 *     target report.
 *  2. Reactions ("983👍66🫡48") live in a sibling `tgme_widget_message_reactions`
 *     div. DOM-scoped extraction excludes them; a regex over the block would not.
 *  3. Line breaks are load-bearing. @sectorv666 and @KozakChornobay put one target
 *     per line under a sticky oblast heading, so `<br/>` must survive as `\n` for the
 *     step-2 parser to segment them.
 *  4. Post ids are not contiguous — deleted posts leave holes — so callers must never
 *     infer "missing id" means "we missed something".
 */
export function parsePage(html: string, channel: string): ParsedMessage[] {
  const root = parse(html);
  const expected = channel.toLowerCase();
  const messages: ParsedMessage[] = [];

  for (const wrap of root.querySelectorAll('.tgme_widget_message_wrap')) {
    const block = wrap.querySelector('[data-post]');
    if (!block) continue;

    const dataPost = block.getAttribute('data-post');
    if (!dataPost) continue;

    const slash = dataPost.lastIndexOf('/');
    if (slash < 0) continue;

    const postChannel = dataPost.slice(0, slash);
    // Guards against forwarded or embedded blocks from another channel.
    if (postChannel.toLowerCase() !== expected) continue;

    const messageId = Number.parseInt(dataPost.slice(slash + 1), 10);
    if (!Number.isSafeInteger(messageId) || messageId <= 0) continue;

    const datetime = block
      .querySelector('.tgme_widget_message_date time')
      ?.getAttribute('datetime');
    if (!datetime) continue;

    const postedAt = Date.parse(datetime);
    // Never invent a timestamp — posted_at is the authoritative event time that the
    // bot's "is this target near me right now" logic depends on.
    if (Number.isNaN(postedAt)) continue;

    // First match only, and `js-message_text` is what excludes reply previews.
    const body = block.querySelector('.tgme_widget_message_text.js-message_text');
    const textHtml = body ? body.innerHTML : null;

    messages.push({
      channel: expected,
      messageId,
      postedAt,
      text: textHtml === null ? '' : normaliseText(textHtml),
      textHtml,
      hasMedia: hasMedia(block),
    });
  }

  messages.sort((a, b) => a.messageId - b.messageId);
  return messages;
}

function hasMedia(block: HTMLElement): boolean {
  return (
    block.querySelector(
      '.tgme_widget_message_photo_wrap, .tgme_widget_message_video_player, ' +
        '.tgme_widget_message_document, .tgme_widget_message_voice, ' +
        '.tgme_widget_message_roundvideo_player, .tgme_widget_message_sticker',
    ) !== null
  );
}

/**
 * Message HTML -> plain text, preserving line structure.
 *
 * Re-parsing after the `<br/>` substitution is what decodes entities (`&quot;` -> `"`)
 * and flattens nested markup such as `<tg-emoji><i><b>🏍</b></i></tg-emoji>` to a
 * single emoji.
 */
export function normaliseText(innerHtml: string): string {
  const withBreaks = innerHtml.replace(/<br\s*\/?>/gi, '\n');
  const text = parse(withBreaks).textContent;

  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    // Collapse runs of blank lines to a single blank line: channels use double
    // spacing between oblast groups, and step 2 reads those groups.
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
