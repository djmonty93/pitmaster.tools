// One-off dev tool (like render-pins.mjs): rasterize the simplified single-arc
// gauge mark to 16/32/48 px PNGs and pack favicon.ico. Run locally with
//   node scripts/gen-favicon.mjs
// Never wired into npm run build / deploy. Requires the `sharp` devDependency.
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';

// Simplified gauge (no ticks/gradient) — reads cleanly at 16px. Same geometry
// as the header badge in _partials/site-header.html and og/brand/gauge.svg.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
  <circle cx="60" cy="60" r="54" fill="#FBEED8" stroke="#26231F" stroke-width="8"/>
  <path d="M27.1 79 A38 38 0 1 0 92.9 79" fill="none" stroke="#ED7818" stroke-width="11" stroke-linecap="round"/>
  <line x1="60" y1="60" x2="79.5" y2="32.2" stroke="#B02C1A" stroke-width="8" stroke-linecap="round"/>
  <circle cx="60" cy="60" r="9" fill="#26231F"/>
</svg>`;

const sizes = [16, 32, 48];
const pngs = [];
for (const s of sizes) {
  const buf = await sharp(Buffer.from(svg))
    .resize(s, s, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  pngs.push({ size: s, buf });
  console.log(`rendered ${s}x${s} -> ${buf.length} bytes`);
}

// Pack PNG-in-ICO: 6-byte ICONDIR + 16-byte ICONDIRENTRY per image + PNG data.
const count = pngs.length;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(count, 4);

const entries = Buffer.alloc(16 * count);
let offset = 6 + 16 * count;
pngs.forEach(({ size, buf }, i) => {
  const e = i * 16;
  entries.writeUInt8(size >= 256 ? 0 : size, e + 0); // width
  entries.writeUInt8(size >= 256 ? 0 : size, e + 1); // height
  entries.writeUInt8(0, e + 2); // palette
  entries.writeUInt8(0, e + 3); // reserved
  entries.writeUInt16LE(1, e + 4); // color planes
  entries.writeUInt16LE(32, e + 6); // bits per pixel
  entries.writeUInt32LE(buf.length, e + 8); // image size
  entries.writeUInt32LE(offset, e + 12); // offset
  offset += buf.length;
});

const ico = Buffer.concat([header, entries, ...pngs.map((p) => p.buf)]);
writeFileSync('favicon.ico', ico);
console.log(`wrote favicon.ico (${ico.length} bytes, ${count} images)`);
