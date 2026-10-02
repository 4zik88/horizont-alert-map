import { logger } from '../logger.js';
import { htmlToText, type PushSender } from './push.js';

/** Anything that can deliver a warning to a user. TelegramApi satisfies it. */
export interface MessageSink {
  sendMessage(chatId: number, html: string): Promise<void>;
}

/**
 * One warning, every channel the user has: the Telegram DM and each subscribed
 * browser. It counts as delivered when any channel took it — so the anti-spam ledger
 * holds it back next time — and throws only when none did, so it is retried.
 */
export function fanout(telegram: MessageSink | undefined, push: PushSender | undefined): MessageSink | undefined {
  if (!telegram && !push) return undefined;
  if (!push) return telegram;

  return {
    async sendMessage(chatId, html) {
      const text = htmlToText(html);
      const [tg, web] = await Promise.allSettled([
        telegram ? telegram.sendMessage(chatId, html) : Promise.reject(new Error('no telegram')),
        push.send(chatId, { ...notificationOf(text), url: '/' }),
      ]);
      const telegramOk = telegram !== undefined && tg.status === 'fulfilled';
      const pushOk = web.status === 'fulfilled' && web.value > 0;
      if (web.status === 'rejected') {
        logger.warn({ err: String(web.reason) }, 'push delivery failed');
      }
      if (telegramOk || pushOk) return;
      throw tg.status === 'rejected' && telegram ? tg.reason : new Error('no channel delivered');
    },
  };
}

const DISCLAIMER = 'Дані з відкритих джерел, не є офіційним попередженням.';

/**
 * A system notification shows a short title and clips it hard, so the title is only
 * the headline — "⚠️ БпЛА", "🚨 Повітряна тривога" — with a count when several warnings
 * came at once, and every detail goes in the body. Putting the whole first line in
 * the title cut "~19 хв (орієнтовно)" off at exactly the part that mattered.
 */
export function notificationOf(text: string): { title: string; body: string } {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const first = lines[0] ?? '';
  const cut = first.indexOf(' — ');
  const head = cut > 0 ? first.slice(0, cut) : first;
  const title = (head.length > 60 ? `${head.slice(0, 59)}…` : head) + (lines.length > 1 ? ` +${lines.length - 1}` : '');
  const details = [cut > 0 ? first.slice(cut + 3) : '', ...lines.slice(1)].filter(Boolean).join('\n');
  const body = details ? `${details}\n${DISCLAIMER}` : DISCLAIMER;
  return { title, body: body.length > 500 ? `${body.slice(0, 499)}…` : body };
}
