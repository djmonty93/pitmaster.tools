/**
 * gen-og-image.mjs — regenerate the shared 1200x630 social card (og-image.png).
 *
 * LOCAL / OFFLINE TOOL ONLY (like render-pins.mjs): launches headless Chromium,
 * never run in build/deploy. Brand fonts (Zilla Slab 700 + Oswald) and the
 * hero-home food photo are base64-embedded so the render is fully offline. The
 * signature score gauge uses a dark-bg variant (cream needle/hub/number) so it
 * reads over the photo. The @2x capture is palette-quantized down to the
 * ~140-250 KB range shared by every other OG asset.
 *
 *   node scripts/gen-og-image.mjs        # -> og-image.png (1200x630, palette-optimized)
 */
import { chromium } from "playwright";
import sharp from "sharp";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const W = 1200, H = 630, SCALE = 2;

// Signature gauge (dark-bg variant). Same geometry as _partials/gauge-svg.js.
function gauge(score, color) {
  const R = 90, CX = 110, CY = 110, SEMI = Math.PI * R;
  const s = Math.max(0, Math.min(100, score));
  const filled = (s / 100) * SEMI;
  const theta = Math.PI * (1 - s / 100);
  const nx = (CX + (R - 14) * Math.cos(theta)).toFixed(1);
  const ny = (CY - (R - 14) * Math.sin(theta)).toFixed(1);
  return `<svg viewBox="0 0 220 150" xmlns="http://www.w3.org/2000/svg" width="360">
    <path d="M20 110 A90 90 0 0 1 200 110" fill="none" stroke="#E6D9BE" stroke-width="16" stroke-linecap="round"/>
    <path d="M20 110 A90 90 0 0 1 200 110" fill="none" stroke="${color}" stroke-width="16" stroke-linecap="round" stroke-dasharray="${filled.toFixed(2)} ${SEMI.toFixed(2)}"/>
    <line x1="${CX}" y1="${CY}" x2="${nx}" y2="${ny}" stroke="#FBEED8" stroke-width="6" stroke-linecap="round"/>
    <circle cx="${CX}" cy="${CY}" r="9" fill="#FBEED8"/>
    <text x="${CX}" y="${CY + 38}" text-anchor="middle" font-family="'Zilla Slab',Georgia,serif" font-weight="700" font-size="42" fill="#FBEED8">${s}</text>
  </svg>`;
}

async function run() {
  const b64 = async (f) => (await readFile(path.join("og", "fonts", f))).toString("base64");
  const [zilla, oswald] = await Promise.all([b64("zilla-slab-700.woff2"), b64("oswald.woff2")]);
  const badge = (await readFile(path.join("og", "brand", "gauge.svg"))).toString("base64");
  const heroHome = (await readFile(path.join("og", "img", "hero-home.jpg"))).toString("base64");

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    @font-face{font-family:'Zilla Slab';font-weight:700;src:url(data:font/woff2;base64,${zilla}) format('woff2')}
    @font-face{font-family:'Oswald';font-weight:200 700;src:url(data:font/woff2;base64,${oswald}) format('woff2')}
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:${W}px;height:${H}px}
    .card{width:${W}px;height:${H}px;background:#26231F;color:#FBEED8;position:relative;overflow:hidden;display:flex;align-items:center;font-family:'Oswald',sans-serif}
    .photo{position:absolute;inset:0;background:url(data:image/jpeg;base64,${heroHome}) center/cover no-repeat}
    .scrim{position:absolute;inset:0;background:linear-gradient(100deg,rgba(18,13,8,.95) 0%,rgba(18,13,8,.86) 40%,rgba(18,13,8,.42) 66%,rgba(18,13,8,.62) 100%)}
    .card > .left,.card > .right{position:relative;z-index:1}
    .left{flex:1;padding:64px 0 64px 70px}
    .brand{display:flex;align-items:center;gap:16px;margin-bottom:38px}
    .brand img{width:60px;height:60px;display:block}
    .wm{font-family:'Zilla Slab',serif;font-weight:700;font-size:38px;letter-spacing:-.01em}
    .wm .tld{color:#FAB746}
    .eyb{font-family:'Oswald',sans-serif;font-weight:600;text-transform:uppercase;letter-spacing:.2em;font-size:22px;color:#ED7818;margin-bottom:18px}
    .head{font-family:'Zilla Slab',serif;font-weight:700;font-size:58px;line-height:1.04;letter-spacing:-1px;margin-bottom:22px}
    .sub{font-family:'Oswald',sans-serif;font-weight:400;font-size:26px;line-height:1.4;color:#CDBFA6;max-width:600px}
    .right{flex:0 0 400px;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;border-left:1px solid rgba(251,238,216,.16);background:rgba(18,13,8,.46)}
    .right .lbl{font-family:'Oswald',sans-serif;font-weight:600;text-transform:uppercase;letter-spacing:.22em;font-size:20px;color:#ED7818}
    .tick{position:absolute;top:60px;right:60px;display:flex;gap:10px;width:70px;height:22px}
    .tick i{flex:1;background:#ED7818;opacity:.5}.tick i:last-child{opacity:1}
  </style></head><body>
    <div class="card">
      <div class="photo"></div>
      <div class="scrim"></div>
      <span class="tick"><i></i><i></i><i></i></span>
      <div class="left">
        <div class="brand"><img src="data:image/svg+xml;base64,${badge}"><span class="wm">pitmaster<span class="tld">.tools</span></span></div>
        <div class="eyb">BBQ Calculators + Smoke Forecasts</div>
        <div class="head">Free cook times &amp;<br>weather-scored smoke days</div>
        <div class="sub">Cook times, pull temps and wood pairings &mdash; plus a 0&ndash;100 smoke score for your ZIP. No signup.</div>
      </div>
      <div class="right">
        <div class="lbl">Today&rsquo;s Smoke Score</div>
        ${gauge(94, "#1F5DAA")}
      </div>
    </div>
  </body></html>`;

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: SCALE });
  await page.setContent(html, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const buf = await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
  await browser.close();
  // The card is now a full-bleed food photo, so a truecolor PNG would balloon to ~2 MB.
  // Downscale the @2x capture to the 1200x630 spec and palette-quantize to keep it in the
  // ~140-250 KB range of every other OG asset (and under social scrapers' thumbnail caps).
  const optimized = await sharp(buf).resize(W, H).png({ palette: true, quality: 90, colours: 256, dither: 1.0 }).toBuffer();
  await writeFile("og-image.png", optimized);
  console.log(`wrote og-image.png (${W}x${H}, ${(optimized.length / 1024).toFixed(0)} KB, palette-optimized)`);
}
run();
