import { logger } from '../logger.js';

/**
 * Minimal Telegram Bot API client.
 *
 * The bot needs four methods, so a plain fetch wrapper is lighter than a framework
 * and matches the rest of the project (native fetch, no HTTP client dependency).
 *
 * Long polling, not webhooks: the service runs as a single Railway process with one
 * replica, so there is no public callback to register and nothing to coordinate.
 */

export interface TelegramLocation {
  latitude: number;
  longitude: number;
  live_period?: number;
  horizontal_accuracy?: number;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: string; username?: string; first_name?: string };
  from?: { id: number; username?: string; first_name?: string; is_bot?: boolean };
  text?: string;
  location?: TelegramLocation;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  /** Live location updates arrive as edits to the original message, not new ones. */
  edited_message?: TelegramMessage;
}

export class TelegramApi {
  private readonly base: string;

  constructor(token: string) {
    this.base = `https://api.telegram.org/bot${token}`;
  }

  private async call<T>(method: string, payload: unknown, timeoutMs: number): Promise<T> {
    const response = await fetch(`${this.base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const body = (await response.json()) as { ok: boolean; result?: T; description?: string };
    if (!body.ok) {
      // The token itself must never reach a log line or an error message.
      throw new Error(`telegram ${method} failed: ${body.description ?? response.status}`);
    }
    return body.result as T;
  }

  /**
   * Long-poll for updates. `offset` acknowledges everything before it, so it must be
   * persisted — otherwise a restart replays old commands and old locations.
   */
  async getUpdates(offset: number, timeoutSeconds: number): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>(
      'getUpdates',
      {
        offset,
        timeout: timeoutSeconds,
        // edited_message is required: a live location moves by editing its message.
        allowed_updates: ['message', 'edited_message'],
      },
      (timeoutSeconds + 15) * 1000,
    );
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    await this.call('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }, 15_000);
  }

  async getMe(): Promise<{ id: number; username?: string }> {
    return this.call('getMe', {}, 15_000);
  }
}

/**
 * Send without letting one bad chat break a broadcast.
 *
 * A user who blocked the bot returns 403 forever; that must not stop the other nine
 * people from being warned.
 */
export async function trySend(
  api: { sendMessage(chatId: number, text: string): Promise<void> },
  chatId: number,
  text: string,
): Promise<boolean> {
  try {
    await api.sendMessage(chatId, text);
    return true;
  } catch (error) {
    // chatId is a user identifier, so it is logged only as a coarse hint, never
    // alongside coordinates.
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'telegram send failed',
    );
    return false;
  }
}
