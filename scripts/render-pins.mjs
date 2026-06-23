/**
 * render-pins.mjs
 * Turn pins.json into Pinterest-ready 1000x1500 PNGs.
 *
 * LOCAL / OFFLINE TOOL ONLY. This launches a headless Chromium and must never
 * run in the build or deploy pipeline (no browser at deploy time). It is a
 * developer step: render the per-calculator pin images, then commit them under
 * og/ so build.js copies og/ → dist/og/ and pages reference /og/<slug>.png.
 *
 * Setup (one-time, Node 18+):
 *   npm i -D playwright
 *   npx playwright install chromium
 *
 * Run from the repo root:
 *   npm run pins:render                 # → og/<slug>.png at 2x density
 *   node scripts/render-pins.mjs --scale=1   # exact 1000x1500 instead of 2x
 *   node scripts/render-pins.mjs --out=./staging
 *
 * Output: one PNG per pin named by `slug`, in og/ by default.
 *
 * Notes:
 *  - Fonts load from Google Fonts at render time, so the machine needs internet
 *    on first run (Chromium caches them). To go fully offline, self-host the
 *    woff2 files and swap the <link> for an @font-face block.
 *  - SCALE=2 produces 2000x3000, which Pinterest downsamples crisply. The pin's
 *    layout is identical; only pixel density changes.
 */

import { chromium } from "playwright";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  })
);

const OUT = args.out || "og";
const SCALE = Number(args.scale || 2);
const PIN_W = 1000;
const PIN_H = 1500;

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

// headline string with "\n" -> <br>
const headLines = (s) => esc(s).replace(/\n/g, "<br>");

function buildBody(p) {
  const eyb = `<div class="eyb">${esc(p.eyebrow || "")}</div>`;
  const head = `<div class="head">${headLines(p.head || "")}</div>`;

  switch (p.type) {
    case "cheatsheet": {
      const rows = (p.rows || [])
        .map(([l, r]) => `<tr><td>${esc(l)}</td><td>${esc(r)}</td></tr>`)
        .join("");
      const sub = p.sub ? `<div class="sub">${esc(p.sub)}</div>` : "";
      return `${eyb}${head}${sub}<table>${rows}</table>`;
    }
    case "answer": {
      const big = esc(p.answer?.big || "");
      const small = p.answer?.small
        ? `<small>${esc(p.answer.small)}</small>`
        : "";
      return `${eyb}${head}<div class="answer"><div class="n">${big}${small}</div></div>`;
    }
    case "seasonal":
    case "utility":
    default: {
      const sub = p.sub ? `<div class="sub">${esc(p.sub)}</div>` : "";
      return `${eyb}${head}${sub}`;
    }
  }
}

function buildPinHTML(p) {
  const warm = p.variant === "warm" ? " warm" : "";
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=JetBrains+Mono:wght@400;700&family=Public+Sans:wght@600&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box;font-synthesis:none}
  html,body{width:${PIN_W}px;height:${PIN_H}px}
  .pin{width:${PIN_W}px;height:${PIN_H}px;position:relative;overflow:hidden;
    background:#1c140d;color:#f3ead8;display:flex;flex-direction:column;
    font-family:'Public Sans',sans-serif;-webkit-font-smoothing:antialiased}
  .pin.warm{background:linear-gradient(160deg,#b8401f,#7d2a14)}
  .brand{position:absolute;top:50px;left:60px;font-family:'JetBrains Mono',monospace;
    font-weight:700;font-size:31px;letter-spacing:.18em;color:#d9542e}
  .pin.warm .brand{color:#ffd9c9}
  .tick{position:absolute;top:54px;right:60px;width:70px;height:24px;display:flex;gap:10px}
  .tick i{flex:1;background:#d9542e;opacity:.5}
  .tick i:last-child{opacity:1}
  .pin.warm .tick i{background:#ffd9c9}
  .body{flex:1;display:flex;flex-direction:column;justify-content:center;padding:60px 60px 0}
  .eyb{font-family:'JetBrains Mono',monospace;font-size:30px;letter-spacing:.22em;
    text-transform:uppercase;color:#d9542e;margin-bottom:25px}
  .pin.warm .eyb{color:#ffd9c9}
  .head{font-family:'Anton',sans-serif;text-transform:uppercase;line-height:.92;
    font-size:115px;letter-spacing:.5px}
  .sub{font-size:40px;color:#cdbfa6;margin-top:30px;line-height:1.3;font-weight:600}
  .pin.warm .sub{color:#ffe4d8}
  table{width:100%;border-collapse:collapse;margin-top:50px;font-family:'JetBrains Mono',monospace}
  td{padding:26px 0;border-top:4px solid #463422;font-size:44px}
  td:first-child{color:#e8ddc7}
  td:last-child{text-align:right;color:#d9542e;font-weight:700}
  .answer{margin-top:40px;background:#33230f;border-left:14px solid #d9542e;padding:40px 45px}
  .answer .n{font-family:'Anton',sans-serif;font-size:90px;line-height:.95;color:#fff}
  .answer .n small{font-family:'JetBrains Mono',monospace;font-size:34px;color:#cdbfa6;
    letter-spacing:.5px;display:block;margin-top:15px;font-weight:400}
  .cta{margin:60px 60px;background:#d9542e;color:#1c140d;font-family:'JetBrains Mono',monospace;
    font-weight:700;font-size:37px;letter-spacing:.04em;text-align:center;padding:36px;text-transform:uppercase}
  .pin.warm .cta{background:#1c140d;color:#ffd9c9}
  .foot{padding:0 60px 50px;font-family:'JetBrains Mono',monospace;font-size:28px;
    letter-spacing:.1em;color:#8a7d66;text-align:center}
  .pin.warm .foot{color:#f0c3b3}
</style></head>
<body>
  <div class="pin${warm}">
    <span class="brand">${esc(p.brand || "PITMASTER.TOOLS")}</span>
    <span class="tick"><i></i><i></i><i></i></span>
    <div class="body">${buildBody(p)}</div>
    <div class="cta">${esc(p.cta || "")}</div>
    <div class="foot">${esc(p.foot || "")}</div>
  </div>
</body></html>`;
}

async function run() {
  let pins;
  try {
    pins = JSON.parse(await readFile("pins.json", "utf8"));
  } catch (e) {
    console.error("Could not read pins.json:", e.message);
    process.exit(1);
  }

  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: PIN_W, height: PIN_H },
    deviceScaleFactor: SCALE,
  });

  for (const p of pins) {
    const name = p.slug || p.id || "pin";
    try {
      await page.setContent(buildPinHTML(p), { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);
      const file = path.join(OUT, `${name}.png`);
      await page.screenshot({ path: file, clip: { x: 0, y: 0, width: PIN_W, height: PIN_H } });
      console.log("rendered", file);
    } catch (e) {
      console.error("failed", name, e.message);
    }
  }

  await browser.close();
  console.log(`\nDone. ${pins.length} pin(s) in ./${OUT} at ${PIN_W * SCALE}x${PIN_H * SCALE}.`);
}

run();
