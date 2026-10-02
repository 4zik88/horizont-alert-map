/**
 * Generate a VAPID key pair for Web Push. Run once per deployment:
 *   pnpm vapid:keys
 * Put both keys and VAPID_SUBJECT on the worker, and VAPID_PUBLIC_KEY on the API.
 * Changing the pair later invalidates every existing browser subscription.
 */
import webpush from 'web-push';

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log('VAPID_SUBJECT=mailto:<you@example.com>');
