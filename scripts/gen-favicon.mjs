// One-off dev tool (like render-pins.mjs): rasterize the FULL gauge badge
// (og/brand/gauge.svg) to favicon PNGs + apple-touch-icon and pack favicon.ico.
// Per the brand lockup: ship the full gauge as SVG + PNG at 16/32/48 and a
// 180px apple-touch-icon (modern browsers prefer the SVG; PNGs are fallbacks).
// Run locally:  node scripts/gen-favicon.mjs
// Never wired into npm run build / deploy. Requires the `sharp` devDependency.
import sharp from 'sharp';
import { writeFileSync, readFileSync } from 'node:fs';

const BADGE = 'og/brand/gauge.svg';
const CREAM = { r: 0xFB, g: 0xEE, b: 0xD8, alpha: 1 }; // #FBEED8 apple-touch tile

// favicon.ico — full gauge, transparent corners, 16/32/48.
const sizes = [16, 32, 48];
const pngs = [];
for (const s of sizes) {
  const buf = await sharp(BADGE)
    .resize(s, s, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  pngs.push({ size: s, buf });
  console.log(`favicon ${s}x${s} -> ${buf.length} bytes`);
}

// Pack PNG-in-ICO: 6-byte ICONDIR + 16-byte ICONDIRENTRY per image + PNG data.
const count = pngs.length;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(count, 4);
const entries = Buffer.alloc(16 * count);
let offset = 6 + 16 * count;
pngs.forEach(({ size, buf }, i) => {
  const e = i * 16;
  entries.writeUInt8(size >= 256 ? 0 : size, e + 0);
  entries.writeUInt8(size >= 256 ? 0 : size, e + 1);
  entries.writeUInt8(0, e + 2);
  entries.writeUInt8(0, e + 3);
  entries.writeUInt16LE(1, e + 4);
  entries.writeUInt16LE(32, e + 6);
  entries.writeUInt32LE(buf.length, e + 8);
  entries.writeUInt32LE(offset, e + 12);
  offset += buf.length;
});
writeFileSync('favicon.ico', Buffer.concat([header, entries, ...pngs.map((p) => p.buf)]));
console.log(`wrote favicon.ico (${offset} bytes, ${count} images)`);

// apple-touch-icon — 180px full gauge on an opaque cream tile (iOS masks to a
// rounded square; a filled tile avoids black corners on older iOS).
const badge180 = await sharp(BADGE).resize(164, 164).png().toBuffer();
await sharp({ create: { width: 180, height: 180, channels: 4, background: CREAM } })
  .composite([{ input: badge180, gravity: 'center' }])
  .png()
  .toFile('og/apple-touch-icon.png');
console.log('wrote og/apple-touch-icon.png (180x180)');
