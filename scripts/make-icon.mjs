// Writes media/icon.png: a 128x128 RGBA PNG (dark rounded tile, one green and two yellow offset bars).
// Dependency-free: Node's zlib plus a manual CRC32. Run: node scripts/make-icon.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const SIZE = 128;
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'media', 'icon.png');

const BG = [0x0d, 0x11, 0x17];
const GREEN = [0x3f, 0xb9, 0x50];
const YELLOW = [0xe3, 0xb3, 0x41];

/** Coverage (0..1) of a rounded rectangle at pixel centre (x, y); 4x4 supersampling for smooth edges. */
function roundedRectCoverage(x, y, rx, ry, rw, rh, radius) {
  let hits = 0;
  for (let sy = 0; sy < 4; sy += 1) {
    for (let sx = 0; sx < 4; sx += 1) {
      const px = x + (sx + 0.5) / 4;
      const py = y + (sy + 0.5) / 4;
      if (px < rx || py < ry || px >= rx + rw || py >= ry + rh) continue;
      const cx = Math.min(Math.max(px, rx + radius), rx + rw - radius);
      const cy = Math.min(Math.max(py, ry + radius), ry + rh - radius);
      const dx = px - cx;
      const dy = py - cy;
      if (dx * dx + dy * dy <= radius * radius) hits += 1;
    }
  }
  return hits / 16;
}

// Three bars of different widths and x offsets: they read as "a file list that is shaking".
const bars = [
  { x: 22, y: 30, w: 70, h: 18, color: GREEN },
  { x: 36, y: 55, w: 72, h: 18, color: YELLOW },
  { x: 18, y: 80, w: 58, h: 18, color: YELLOW },
];

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y += 1) {
  const row = y * (SIZE * 4 + 1);
  raw[row] = 0; // filter: none
  for (let x = 0; x < SIZE; x += 1) {
    const tile = roundedRectCoverage(x, y, 0, 0, SIZE, SIZE, 22);
    let r = BG[0];
    let g = BG[1];
    let b = BG[2];
    for (const bar of bars) {
      const c = roundedRectCoverage(x, y, bar.x, bar.y, bar.w, bar.h, 6);
      if (c > 0) {
        r = Math.round(r * (1 - c) + bar.color[0] * c);
        g = Math.round(g * (1 - c) + bar.color[1] * c);
        b = Math.round(b * (1 - c) + bar.color[2] * c);
      }
    }
    const i = row + 1 + x * 4;
    raw[i] = r;
    raw[i + 1] = g;
    raw[i + 2] = b;
    raw[i + 3] = Math.round(tile * 255);
  }
}

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes, ${SIZE}x${SIZE})`);
