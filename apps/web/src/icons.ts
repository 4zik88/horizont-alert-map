import type { TargetType } from '@horizont/contract';

/**
 * Simple silhouettes in a 32x32 box, nose pointing north (up) so a CSS rotation by the
 * compass heading points them the right way. `fill` and `stroke` come from the caller:
 * filled means the target IS there, hollow means it is only heading somewhere.
 */
const SHAPES: Record<TargetType, string> = {
  // Shahed: delta wing.
  uav: '<path d="M16 3 L28 25 L19 22 L16 27 L13 22 L4 25 Z"/>',
  // Jet drone: slimmer delta with a tail.
  jet_uav: '<path d="M16 2 L18 12 L27 22 L18 20 L17 27 L20 30 L12 30 L15 27 L14 20 L5 22 L14 12 Z"/>',
  // Cruise missile: long body, short wings.
  cruise: '<path d="M16 2 L18 7 L18 18 L24 22 L18 22 L18 27 L21 30 L11 30 L14 27 L14 22 L8 22 L14 18 L14 7 Z"/>',
  // Ballistic: fat body with fins.
  ballistic: '<path d="M16 2 L20 9 L20 23 L25 30 L7 30 L12 23 L12 9 Z"/>',
  // Guided bomb: bomb with tail fins.
  kab: '<path d="M16 3 C20 3 21 8 21 12 L21 22 L25 28 L7 28 L11 22 L11 12 C11 8 12 3 16 3 Z"/>',
  // Aircraft: swept wings and tailplane.
  aviation:
    '<path d="M16 2 L18 10 L29 18 L29 20 L18 17 L18 25 L22 29 L22 30 L16 28 L10 30 L10 29 L14 25 L14 17 L3 20 L3 18 L14 10 Z"/>',
  // Recon drone: straight long wings.
  recon: '<path d="M15 4 L17 4 L17 12 L29 13 L29 16 L17 16 L17 24 L21 26 L21 28 L11 28 L11 26 L15 24 L15 16 L3 16 L3 13 L15 12 Z"/>',
  // Unknown: a diamond with a question mark is too busy at 30 px; a plain diamond.
  unknown: '<path d="M16 4 L27 16 L16 28 L5 16 Z"/>',
};

export interface IconOptions {
  hollow: boolean;
  stale: boolean;
}

export function targetSvg(type: TargetType, o: IconOptions): string {
  const colour = o.stale ? '#8a8f98' : type === 'ballistic' || type === 'cruise' ? '#ff5a4f' : '#ffb020';
  const fill = o.hollow ? 'none' : colour;
  const dash = o.hollow ? ' stroke-dasharray="3 2"' : '';
  return (
    `<svg viewBox="0 0 32 32" aria-hidden="true">` +
    `<g fill="${fill}" stroke="${o.hollow ? colour : '#111'}" stroke-width="${o.hollow ? 2 : 1.2}" stroke-linejoin="round"${dash}>` +
    SHAPES[type] +
    `</g></svg>`
  );
}

/** A launch site: a burst, never a target. */
export function launchSvg(stale: boolean): string {
  const c = stale ? '#8a8f98' : '#ff7a2f';
  const rays = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4;
    const x1 = 16 + Math.sin(a) * 6, y1 = 16 - Math.cos(a) * 6;
    const x2 = 16 + Math.sin(a) * 14, y2 = 16 - Math.cos(a) * 14;
    return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
  }).join('');
  return (
    `<svg viewBox="0 0 32 32" aria-hidden="true"><g stroke="${c}" stroke-width="2.5" stroke-linecap="round">${rays}</g>` +
    `<circle cx="16" cy="16" r="4" fill="${c}" stroke="#111" stroke-width="1"/></svg>`
  );
}
