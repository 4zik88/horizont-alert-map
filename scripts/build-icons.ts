/**
 * Generates the PWA icons.
 *
 *   npm run build:icons
 *
 * Writes real PNGs with a tiny encoder rather than pulling in an image library for
 * two static files. iOS needs a PNG for the home-screen icon specifically — an SVG
 * is silently ignored there, and the app then installs with a blank tile.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Minimal 8-bit RGBA PNG. */
function png(size: number, pixel: (x: number, y: number) => [number, number, number, number]): Buffer {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let offset = 0;
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw[offset++] = r; raw[offset++] = g; raw[offset++] = b; raw[offset++] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A radar sweep: concentric rings with a bearing line, on the app's dark ground. */
function icon(size: number): Buffer {
  const c = size / 2;
  const unit = size / 512;

  return png(size, (x, y) => {
    const dx = x - c;
    const dy = y - c;
    const dist = Math.hypot(dx, dy);

    // Maskable icons are cropped to a circle on Android; keep art well inside.
    if (dist > c - 2 * unit) return [13, 17, 23, 255];

    for (const r of [96, 160, 224]) {
      if (Math.abs(dist - r * unit) < 7 * unit) return [88, 166, 255, 255];
    }

    // Bearing line to the north-east, echoing the course arrows on the map.
    const angle = Math.atan2(-dy, dx);
    if (dist < 232 * unit && Math.abs(angle - Math.PI / 4) < 0.055) return [248, 81, 73, 255];

    if (dist < 26 * unit) return [248, 81, 73, 255];
    return [13, 17, 23, 255];
  });
}

mkdirSync('public/icons', { recursive: true });
for (const size of [192, 512]) {
  const file = `public/icons/icon-${size}.png`;
  writeFileSync(file, icon(size));
  console.log(`wrote ${file}`);
}
