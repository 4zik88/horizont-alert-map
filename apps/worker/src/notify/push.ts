import { forgetPushEndpoint, pushSubscriptionsOf, type Sql } from '@horizont/db';
import webpush from 'web-push';
import { logger } from '../logger.js';

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  /** A mailto: or https: contact the push services can reach if something misbehaves. */
  subject: string;
}

export interface PushPayload {
  title: string;
  body: string;
  /** Where a tap on the notification opens. */
  url: string;
}

/** The transport, injectable so tests never reach a real push service. */
export type PushTransport = (
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
  options: webpush.RequestOptions,
) => Promise<{ statusCode: number }>;

/**
 * Web Push delivery to every browser a user subscribed from.
 *
 * TTL is short on purpose: a warning that reaches a phone that was off for an hour
 * is not a warning any more, and the push service should drop it rather than deliver
 * it late as if it were current.
 */
export class PushSender {
  private readonly sql: Sql;
  private readonly vapid: VapidConfig;
  private readonly transport: PushTransport;

  constructor(sql: Sql, vapid: VapidConfig, transport: PushTransport = webpush.sendNotification) {
    this.sql = sql;
    this.vapid = vapid;
    this.transport = transport;
  }

  /** Returns how many browsers accepted the message. */
  async send(chatId: number, payload: PushPayload): Promise<number> {
    const subs = await pushSubscriptionsOf(this.sql, chatId);
    let delivered = 0;
    for (const s of subs) {
      try {
        await this.transport(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload),
          {
            TTL: 15 * 60,
            urgency: 'high',
            vapidDetails: { subject: this.vapid.subject, publicKey: this.vapid.publicKey, privateKey: this.vapid.privateKey },
          },
        );
        delivered++;
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        // 404/410: the browser unsubscribed or the subscription expired. It will never
        // work again, so stop trying.
        if (status === 404 || status === 410) {
          await forgetPushEndpoint(this.sql, s.endpoint);
          logger.info({ status }, 'push subscription gone; removed');
        } else {
          // The endpoint is a capability URL; never log it.
          logger.warn({ status, err: error instanceof Error ? error.message : String(error) }, 'push send failed');
        }
      }
    }
    return delivered;
  }
}

/** Telegram's HTML subset, as plain text for a system notification. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}
