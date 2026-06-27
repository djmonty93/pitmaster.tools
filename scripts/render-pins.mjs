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
 *  - Fonts are self-hosted: the brand woff2 (Zilla Slab 700 + Oswald) under
 *    og/fonts/ are base64-embedded as @font-face data URIs, so the render is
 *    fully offline — no Google Fonts dependency.
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

// Self-host the brand fonts as base64 data URIs so the render is fully offline
// (no Google Fonts dependency) and setContent — which has no base URL — can
// still resolve them. Zilla Slab 700 (display) + Oswald (utility/data).
async function fontFaceCss() {
  const load = async (file) =>
    (await readFile(path.join("og", "fonts", file))).toString("base64");
  const [zilla, oswald] = await Promise.all([
    load("zilla-slab-700.woff2"),
    load("oswald.woff2"),
  ]);
  return (
    `@font-face{font-family:'Zilla Slab';font-weight:700;font-style:normal;` +
    `src:url(data:font/woff2;base64,${zilla}) format('woff2')}` +
    `@font-face{font-family:'Oswald';font-weight:200 700;font-style:normal;` +
    `src:url(data:font/woff2;base64,${oswald}) format('woff2')}`
  );
}

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

function buildPinHTML(p, faces) {
  const warm = p.variant === "warm" ? " warm" : "";
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<style>
  ${faces}
  *{margin:0;padding:0;box-sizing:border-box;font-synthesis:none}
  html,body{width:${PIN_W}px;height:${PIN_H}px}
  .pin{width:${PIN_W}px;height:${PIN_H}px;position:relative;overflow:hidden;
    background:#26231F;color:#FBEED8;display:flex;flex-direction:column;
    font-family:'Oswald',sans-serif;-webkit-font-smoothing:antialiased}
  .pin.warm{background:linear-gradient(160deg,#C0341E,#7A2412)}
  .brand{position:absolute;top:50px;left:60px;font-family:'Oswald',sans-serif;
    font-weight:600;font-size:31px;letter-spacing:.18em;color:#ED7818;text-transform:uppercase}
  .pin.warm .brand{color:#FBEED8}
  .tick{position:absolute;top:54px;right:60px;width:70px;height:24px;display:flex;gap:10px}
  .tick i{flex:1;background:#ED7818;opacity:.5}
  .tick i:last-child{opacity:1}
  .pin.warm .tick i{background:#FBEED8}
  .body{flex:1;display:flex;flex-direction:column;justify-content:center;padding:60px 60px 0}
  .eyb{font-family:'Oswald',sans-serif;font-weight:600;font-size:30px;letter-spacing:.22em;
    text-transform:uppercase;color:#ED7818;margin-bottom:25px}
  .pin.warm .eyb{color:#FBEED8}
  .head{font-family:'Zilla Slab',Georgia,serif;font-weight:700;text-transform:uppercase;
    line-height:.96;font-size:92px;letter-spacing:-.5px}
  .sub{font-family:'Oswald',sans-serif;font-weight:500;font-size:38px;color:#CDBFA6;margin-top:30px;line-height:1.3}
  .pin.warm .sub{color:#FFE4D8}
  table{width:100%;border-collapse:collapse;margin-top:50px;font-family:'Oswald',sans-serif}
  td{padding:26px 0;border-top:4px solid #3A342D;font-size:44px}
  td:first-child{color:#EFE3CB;font-weight:500}
  td:last-child{text-align:right;color:#ED7818;font-weight:600}
  .answer{margin-top:40px;background:#1F1C18;border-left:14px solid #ED7818;padding:40px 45px}
  .answer .n{font-family:'Zilla Slab',Georgia,serif;font-weight:700;font-size:92px;line-height:.98;color:#FBEED8}
  .answer .n small{font-family:'Oswald',sans-serif;font-weight:500;font-size:32px;color:#CDBFA6;
    letter-spacing:.5px;display:block;margin-top:15px}
  .cta{margin:60px 60px;background:#ED7818;color:#26231F;font-family:'Oswald',sans-serif;
    font-weight:600;font-size:37px;letter-spacing:.06em;text-align:center;padding:36px;text-transform:uppercase}
  .pin.warm .cta{background:#26231F;color:#FBEED8}
  .foot{padding:0 60px 50px;font-family:'Oswald',sans-serif;font-weight:500;font-size:28px;
    letter-spacing:.1em;color:#9A8D74;text-align:center;text-transform:uppercase}
  .pin.warm .foot{color:#FBEED8}
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
  const faces = await fontFaceCss();
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: PIN_W, height: PIN_H },
    deviceScaleFactor: SCALE,
  });

  let failed = 0;
  for (const p of pins) {
    const name = p.slug || p.id || "pin";
    try {
      await page.setContent(buildPinHTML(p, faces), { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);
      const file = path.join(OUT, `${name}.png`);
      await page.screenshot({ path: file, clip: { x: 0, y: 0, width: PIN_W, height: PIN_H } });
      console.log("rendered", file);
    } catch (e) {
      failed++;
      console.error("failed", name, e.message);
    }
  }

  await browser.close();
  const ok = pins.length - failed;
  console.log(`\nDone. ${ok}/${pins.length} pin(s) in ./${OUT} at ${PIN_W * SCALE}x${PIN_H * SCALE}.`);
  // Fail loudly so a partial render (missing/stale og/<slug>.png) can't pass
  // silently — the caller (and any human re-running pins:render) sees exit 1.
  if (failed > 0) {
    console.error(`${failed} pin(s) failed to render.`);
    process.exitCode = 1;
  }
}

run();
