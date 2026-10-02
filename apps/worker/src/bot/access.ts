import { config } from '../config.js';

/**
 * Closed access list.
 *
 * The bot is for one family, so anyone not on the list gets no reply at all — not
 * even "access denied", which would confirm the bot exists to someone probing.
 *
 * The list lives in env rather than the database on purpose: a compromised database
 * then grants no access, and adding someone is a deploy-time decision.
 */
export interface Identity {
  chatId: number;
  username?: string | undefined;
}

function parseList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

export function allowedChatIds(): number[] {
  return parseList(config.ALLOWED_CHAT_IDS)
    .map((v) => Number.parseInt(v, 10))
    .filter((v) => Number.isSafeInteger(v));
}

export function allowedUsernames(): string[] {
  return parseList(config.ALLOWED_USERNAMES).map((v) => v.replace(/^@/, '').toLowerCase());
}

/**
 * The policy itself, independent of configuration so it can be tested directly —
 * including the empty-list case, which is the one that matters most.
 */
export function isAllowedIn(identity: Identity, ids: number[], names: string[]): boolean {
  // An empty allowlist means nobody, never everybody. Defaulting the other way would
  // silently open a private family tool to the whole internet on a config slip.
  if (ids.length === 0 && names.length === 0) return false;

  if (ids.includes(identity.chatId)) return true;

  const username = identity.username?.replace(/^@/, '').toLowerCase();
  return username !== undefined && username !== '' && names.includes(username);
}

export function isAllowed(identity: Identity): boolean {
  return isAllowedIn(identity, allowedChatIds(), allowedUsernames());
}
