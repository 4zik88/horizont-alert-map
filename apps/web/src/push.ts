/**
 * Web Push, the second warning channel, from the browser's side.
 *
 * What a subscription receives is decided on the server from the location shared with
 * the bot — the same warnings as the Telegram DM. The browser's own location is never
 * sent anywhere, so this toggle does not change what "Де я" does.
 */

export interface PushEnvironment {
  /** The server has a VAPID key, i.e. push is configured. */
  serverKey: string | null;
  /** PushManager, Notification and a service worker all exist. */
  supported: boolean;
  /** iPhone/iPad Safari: push only works in the installed (home-screen) app. */
  ios: boolean;
  /** Running as the installed app. */
  standalone: boolean;
  /** Notification.permission. */
  permission: 'default' | 'granted' | 'denied';
}

export type PushAvailability =
  | { show: false }
  | { show: true; usable: true }
  | { show: true; usable: false; hint: string };

/** Whether to show the toggle, and why it cannot be used when it cannot. */
export function pushAvailability(env: PushEnvironment): PushAvailability {
  if (!env.serverKey) return { show: false };
  if (env.ios && !env.standalone) {
    return { show: true, usable: false, hint: 'На iPhone сповіщення працюють лише у встановленому застосунку: Поділитися → На початковий екран.' };
  }
  if (!env.supported) return { show: true, usable: false, hint: 'Цей браузер не підтримує сповіщення.' };
  if (env.permission === 'denied') {
    return { show: true, usable: false, hint: 'Сповіщення заборонені в налаштуваннях браузера для цього сайту.' };
  }
  return { show: true, usable: true };
}

/** VAPID public key (base64url) as the bytes PushManager.subscribe wants. */
export function keyBytes(base64url: string): Uint8Array {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/* ── browser calls ──────────────────────────────────────────────────────── */

export async function pushInfo(): Promise<{ publicKey: string | null; subscriptions: number }> {
  const res = await fetch('/api/push', { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`push info ${res.status}`);
  return (await res.json()) as { publicKey: string | null; subscriptions: number };
}

export function pushEnvironment(serverKey: string | null): PushEnvironment {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return {
    serverKey,
    supported: 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
    ios,
    standalone: matchMedia('(display-mode: standalone)').matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true,
    permission: 'Notification' in window ? Notification.permission : 'default',
  };
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export type EnableResult = 'ok' | 'denied' | 'failed';

export async function enablePush(publicKey: string): Promise<EnableResult> {
  if ((await Notification.requestPermission()) !== 'granted') return 'denied';
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) as BufferSource }));
    const json = sub.toJSON();
    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
    });
    return res.status === 204 ? 'ok' : 'failed';
  } catch {
    return 'failed';
  }
}

/** Unsubscribe here and on the server. Safe to call when not subscribed. */
export async function disablePush(): Promise<void> {
  const sub = await currentSubscription().catch(() => null);
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => false);
  await fetch('/api/push/unsubscribe', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  }).catch(() => undefined);
}
