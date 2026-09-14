import { logger } from '../logger.js';
import type { Gazetteer } from '../parser/gazetteer.js';
import { oblastByKey } from '../parser/oblasts.js';
import { AppState, Users, DEFAULT_RADIUS_KM, MAX_RADIUS_KM, MIN_RADIUS_KM } from '../db/users.js';
import { TelegramApi, trySend, type TelegramMessage, type TelegramUpdate } from './api.js';
import { isAllowed } from './access.js';
import { HELP, escapeHtml } from './format.js';

const OFFSET_KEY = 'telegram_offset';

export interface BotOptions {
  pollTimeoutSeconds: number;
}

/**
 * Telegram bot: registration, location, /radius, /stop.
 *
 * Access is closed — a message from anyone not on the allowlist is ignored entirely
 * rather than refused, so the bot does not confirm its own existence to a stranger.
 */
export class Bot {
  private readonly api: TelegramApi;
  private readonly users: Users;
  private readonly state: AppState;
  private readonly gazetteer: Gazetteer;
  private readonly opts: BotOptions;
  private stopping = false;
  private loop: Promise<void> | undefined;

  constructor(
    api: TelegramApi,
    users: Users,
    state: AppState,
    gazetteer: Gazetteer,
    opts: BotOptions,
  ) {
    this.api = api;
    this.users = users;
    this.state = state;
    this.gazetteer = gazetteer;
    this.opts = opts;
  }

  start(): void {
    this.loop = this.run();
    logger.info('bot started');
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.loop?.catch(() => undefined);
    logger.info('bot stopped');
  }

  private async run(): Promise<void> {
    let failures = 0;

    while (!this.stopping) {
      try {
        const offset = this.state.getNumber(OFFSET_KEY, 0);
        const updates = await this.api.getUpdates(offset, this.opts.pollTimeoutSeconds);
        failures = 0;

        for (const update of updates) {
          try {
            await this.handle(update);
          } catch (error) {
            logger.warn(
              { err: error instanceof Error ? error.message : String(error) },
              'bot update handler failed',
            );
          }
          // Acknowledge per update: a crash mid-batch must not replay the whole batch,
          // and must not skip the rest either.
          this.state.setNumber(OFFSET_KEY, update.update_id + 1, Date.now());
        }
      } catch (error) {
        failures++;
        const wait = Math.min(2_000 * 2 ** Math.min(failures, 6), 120_000);
        logger.warn(
          { attempt: failures, waitMs: wait, err: error instanceof Error ? error.message : String(error) },
          'bot poll failed',
        );
        await sleep(wait);
      }
    }
  }

  private async handle(update: TelegramUpdate): Promise<void> {
    // A live location moves by editing its original message, so edits matter as much
    // as new messages — ignoring them means a live location never actually updates.
    const message = update.message ?? update.edited_message;
    if (!message) return;

    const chatId = message.chat.id;
    const username = message.from?.username ?? message.chat.username;

    if (!isAllowed({ chatId, username })) {
      logger.debug('ignored message from a chat that is not on the allowlist');
      return;
    }

    if (message.location) {
      await this.onLocation(message, chatId, username);
      return;
    }

    const text = message.text?.trim();
    if (!text) return;

    const command = text.split(/\s+/)[0]!.toLowerCase().replace(/@.*$/, '');
    switch (command) {
      case '/start':
        this.users.register(chatId, username, Date.now());
        await trySend(this.api, chatId, HELP);
        break;
      case '/help':
        await trySend(this.api, chatId, HELP);
        break;
      case '/radius':
        await this.onRadius(chatId, text);
        break;
      case '/status':
        await trySend(this.api, chatId, this.statusText(chatId));
        break;
      case '/stop':
        this.users.setStopped(chatId, Date.now());
        await trySend(this.api, chatId, '🔕 Сповіщення вимкнено. /start — увімкнути знову.');
        break;
      default:
        await trySend(this.api, chatId, HELP);
    }
  }

  private async onLocation(
    message: TelegramMessage,
    chatId: number,
    username: string | undefined,
  ): Promise<void> {
    const location = message.location!;
    const now = Date.now();

    // A location can arrive before /start; treat it as registration.
    this.users.register(chatId, username, now);

    const live = (location.live_period ?? 0) > 0;
    this.users.saveLocation({
      chatId,
      lat: location.latitude,
      lon: location.longitude,
      kind: live ? 'live' : 'static',
      oblast: this.oblastAt(location.latitude, location.longitude),
      liveUntil: live ? now + location.live_period! * 1000 : null,
      now,
    });

    const user = this.users.get(chatId);
    const oblast = user?.oblast ? oblastByKey(user.oblast)?.name : undefined;

    // Never echo the coordinates back — they would then sit in Telegram's history and
    // in any screenshot of the chat.
    const where = oblast ? ` (${escapeHtml(oblast)} обл.)` : '';
    const mode = live ? 'Live-локацію прийнято, оновлюватиму автоматично.' : 'Локацію збережено.';
    await trySend(
      this.api,
      chatId,
      `📍 ${mode}${where}\nРадіус сповіщення: ${user?.radius_km ?? DEFAULT_RADIUS_KM} км.\nЗмінити: /radius 30`,
    );
  }

  private async onRadius(chatId: number, text: string): Promise<void> {
    const raw = text.split(/\s+/)[1];
    const value = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);

    if (!Number.isFinite(value)) {
      const current = this.users.get(chatId)?.radius_km ?? DEFAULT_RADIUS_KM;
      await trySend(this.api, chatId, `Поточний радіус: ${current} км.\nЗмінити: /radius 30`);
      return;
    }

    if (value < MIN_RADIUS_KM || value > MAX_RADIUS_KM) {
      await trySend(this.api, chatId, `Радіус має бути від ${MIN_RADIUS_KM} до ${MAX_RADIUS_KM} км.`);
      return;
    }

    this.users.updateRadius(chatId, value, Date.now());
    await trySend(this.api, chatId, `✅ Радіус сповіщення: ${value} км.`);
  }

  private statusText(chatId: number): string {
    const user = this.users.get(chatId);
    if (!user) return 'Ви ще не зареєстровані. Надішліть /start.';

    const lines = [
      `Сповіщення: ${user.is_active ? 'увімкнено' : 'вимкнено'}`,
      `Радіус: ${user.radius_km} км`,
    ];

    if (user.lat === null) {
      lines.push('Локація: не задана — надішліть геолокацію');
    } else {
      const oblast = user.oblast ? oblastByKey(user.oblast)?.name : undefined;
      const live = user.location_kind === 'live' && (user.live_until ?? 0) > Date.now();
      lines.push(
        `Локація: ${live ? 'live, оновлюється' : 'збережена'}` +
          `${oblast ? `, ${escapeHtml(oblast)} обл.` : ''}`,
      );
    }

    return lines.join('\n');
  }

  /**
   * Which oblast a point is in.
   *
   * Derived from the nearest gazetteer settlement rather than a polygon lookup: the
   * gazetteer is already loaded, has ~5,700 points across the country, and its
   * oblast tags come from official KATOTTH codes — accurate enough to decide which
   * region's air-raid alert concerns this user.
   */
  private oblastAt(lat: number, lon: number): string | null {
    return this.gazetteer.nearestOblast(lat, lon);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
