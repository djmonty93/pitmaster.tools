/**
 * render-campaign-pins.mjs
 * Composite the 17 "fresh pin" creatives for the 30-day Pinterest launch
 * campaign (docs/pinterest-30-day-plan.md) as 1000x1500 PNGs under og/pins/.
 *
 * Each pin is a photorealistic background photo (generated offline via the
 * image-router MCP and saved under pin-src/<slug>.jpg) with the Pitmaster brand
 * overlay composited on top: brand mark, eyebrow, Zilla Slab headline, an accent
 * line, a CTA pill, and a footer — over a dark gradient scrim for legibility.
 * AI models render text badly, so ALL text is drawn here in real fonts, never
 * baked into the generated photo.
 *
 * LOCAL / OFFLINE TOOL ONLY — same rules as render-pins.mjs: launches headless
 * Chromium (playwright devDep), never runs in build or deploy. The composited
 * PNGs are committed; build.js copies og/ -> dist/og/ recursively so they ship
 * at /og/pins/<slug>.png (the Media URLs in docs/pinterest-30-day-pins.csv).
 * pin-src/ holds the raw source photos and is NOT under og/, so it never ships.
 *
 * Run from the repo root:
 *   node scripts/render-campaign-pins.mjs              # -> og/pins/*.png at 2x
 *   node scripts/render-campaign-pins.mjs --scale=1
 *   node scripts/render-campaign-pins.mjs --only=d15-brisket2,d17-ribs2
 */

import { chromium } from "playwright";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { escapeHtml as esc } from "./lib/text.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  })
);

const OUT = args.out || path.join("og", "pins");
const SRC = args.src || "pin-src";
const SCALE = Number(args.scale || 2);
const PIN_W = 1000;
const PIN_H = 1500;

// Brand palette (matches render-pins.mjs / site-base.css rebrand)
const C = {
  dark: "#1C140D",
  cream: "#FBEED8",
  ember: "#ED7818",
  emberDeep: "#C0341E",
  muted: "#CDBFA6",
};

const headLines = (s) => esc(s).replace(/\n/g, "<br>");

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

/* -------------------------------------------------------------- pin specs
 * head/eyebrow/cta/foot mirror the SVG-era copy; `accent` is the one-line hook
 * from each plan brief. `src` is the source-photo basename under pin-src/. */
const PINS = [
  { slug: "d01-brisket", eyebrow: "Smoker cheat sheet", head: "Brisket\ncook time",
    accent: "Exact hours by weight & smoker temp",
    cta: "Get your exact time →", foot: "FREE BRISKET CALCULATOR" },
  { slug: "d02-ribs", eyebrow: "Low and slow", head: "How long to\nsmoke ribs",
    accent: "Baby back, spare & beef rib timelines",
    cta: "Get your rib timeline →", foot: "FREE RIB CALCULATOR" },
  { slug: "d03-porkbutt", eyebrow: "All-day cook", head: "Pork butt\ncook time",
    accent: "The full schedule by weight & temp",
    cta: "Get your cook time →", foot: "FREE PORK CALCULATOR" },
  { slug: "d04-chart", eyebrow: "Printable cheat sheet", head: "Smoking\ntimes & temps",
    accent: "Every cut, one cheat sheet",
    cta: "See the full chart →", foot: "FREE TIMES & TEMPS CHART" },
  { slug: "d05-meatpp", eyebrow: "Buy the right amount", head: "How much\nmeat per\nperson?",
    accent: "½ lb cooked per guest — do the math",
    cta: "Calculate for your crowd →", foot: "FREE SERVING CALCULATOR" },
  { slug: "d06-coordinator", eyebrow: "Multi-meat timing", head: "Make it all\nfinish\ntogether",
    accent: "No cold brisket waiting on the ribs",
    cta: "Build your schedule →", foot: "FREE COOK COORDINATOR" },
  { slug: "d07-charcoal", eyebrow: "No more refills", head: "How much\ncharcoal?",
    accent: "Exact load for Minion, Snake or direct",
    cta: "Calculate charcoal →", foot: "FREE CHARCOAL CALCULATOR" },
  { slug: "d08-rub", eyebrow: "Stop eyeballing it", head: "Scale any\ndry rub",
    accent: "Salt, sugar & spice, perfectly balanced",
    cta: "Scale your rub →", foot: "FREE DRY RUB CALCULATOR" },
  { slug: "d09-catering", eyebrow: "Feed everyone", head: "Catering a\ncrowd?",
    accent: "Meat, servings & cost for up to 500",
    cta: "Plan your menu →", foot: "FREE CATERING CALCULATOR" },
  { slug: "d10-brine", eyebrow: "Juicy every time", head: "Perfect\nbrine every\ntime",
    accent: "Exact salt, sugar & water by weight",
    cta: "Build your brine →", foot: "FREE BRINE CALCULATOR" },
  { slug: "d11-cost", eyebrow: "Know your number", head: "What does\nyour BBQ\ncost?",
    accent: "Cost per pound and per serving",
    cta: "Calculate your cost →", foot: "FREE BBQ COST CALCULATOR" },
  { slug: "d12-yield", eyebrow: "Trim + cook loss", head: "Brisket\nyield math",
    accent: "A 14 lb packer ≈ 7 lb cooked",
    cta: "Calculate your yield →", foot: "FREE BRISKET YIELD CALCULATOR" },
  { slug: "d14-turkey", eyebrow: "Holiday ready", head: "Smoked\nturkey time",
    accent: "Exact smoke time for any bird",
    cta: "Get your turkey time →", foot: "FREE TURKEY CALCULATOR" },
  { slug: "d13-smokeweather", eyebrow: "This weekend?", head: "Is it a\nsmoke day?",
    accent: "Wind, rain & temp — checked for you",
    cta: "Check your 7-day forecast →", foot: "FREE SMOKE-DAY FORECAST" },
  { slug: "d15-brisket2", eyebrow: "Overnight cook", head: "Brisket\nsleep math",
    accent: "When to light the fire so lunch is on time",
    cta: "Get your fire-up time →", foot: "FREE BRISKET CALCULATOR" },
  { slug: "d16-meatpp2", eyebrow: "Party of 20", head: "How much\nto buy?",
    accent: "Exactly how much meat to buy",
    cta: "Calculate for your crowd →", foot: "FREE SERVING CALCULATOR" },
  { slug: "d17-ribs2", eyebrow: "The classic method", head: "The 3-2-1\nrib clock",
    accent: "Your exact wrap & sauce times",
    cta: "Get your exact stage times →", foot: "FREE RIB CALCULATOR" },
  { slug: "d18-stall", eyebrow: "Don't panic", head: "Stuck at\n165°F?",
    accent: "That's the stall — here's what to do",
    cta: "Read: the stall, explained →", foot: "FREE BBQ GUIDES" },
  { slug: "d19-rub2", eyebrow: "Stop eyeballing it", head: "The rub\nratio",
    accent: "Salt : sugar : spice, scaled to any cut",
    cta: "Scale your rub →", foot: "FREE DRY RUB CALCULATOR" },
  { slug: "d20-coordinator2", eyebrow: "Multi-meat timing", head: "All done\nat 6 PM",
    accent: "Brisket, ribs & chicken — one schedule",
    cta: "Build your schedule →", foot: "FREE COOK COORDINATOR" },
  { slug: "d21-summer", eyebrow: "Peak grilling season", head: "Summer\nsmoking\nguide",
    accent: "Heat, humidity & your smoker",
    cta: "Read the summer guide →", foot: "SEASONAL SMOKING GUIDES" },
  { slug: "d22-porkbutt2", eyebrow: "Pulled pork math", head: "One butt\nfeeds 12",
    accent: "8 lb butt ≈ 5 lb pork ≈ 12 sandwiches",
    cta: "Get your cook time →", foot: "FREE PORK CALCULATOR" },
  { slug: "d23-catering2", eyebrow: "Reunion season", head: "Feed them\nall",
    accent: "Meat, servings & cost for up to 500",
    cta: "Plan your whole menu →", foot: "FREE CATERING CALCULATOR" },
  { slug: "d24-chart2", eyebrow: "Memorize these", head: "Pull temps\nthat matter",
    accent: "Brisket 203° · Pork 203° · Chicken 165°",
    cta: "See the full chart →", foot: "FREE TIMES & TEMPS CHART" },
  { slug: "d25-bestcities", eyebrow: "50 cities, ranked", head: "Best smoking\nweather in\nAmerica",
    accent: "Ranked by real 7-day forecasts",
    cta: "See the leaderboard →", foot: "SMOKE-WEATHER LEADERBOARD" },
  { slug: "d26-charcoal2", eyebrow: "Set & forget", head: "The snake\nmethod",
    accent: "How many briquettes for 8 steady hours",
    cta: "Count your briquettes →", foot: "FREE CHARCOAL CALCULATOR" },
  { slug: "d27-brine2", eyebrow: "Juicy every time", head: "Never dry\nchicken\nagain",
    accent: "Exact brine by weight — wet or dry",
    cta: "Build your brine →", foot: "FREE BRINE CALCULATOR" },
  { slug: "d28-cost2", eyebrow: "Run the numbers", head: "The real\ncost of BBQ",
    accent: "$28 a plate out… or $9 at home?",
    cta: "Calculate your cost per plate →", foot: "FREE BBQ COST CALCULATOR" },
  { slug: "d29-toolshub", eyebrow: "The whole toolbox", head: "13 free BBQ\ncalculators",
    accent: "Time · temps · servings · charcoal · cost",
    cta: "All free · no signup →", foot: "PITMASTER.TOOLS" },
  { slug: "d30-brisket3", eyebrow: "Know your cut", head: "Flat vs\npacker",
    accent: "Different cuts, very different clocks",
    cta: "Get timing for your cut →", foot: "FREE BRISKET CALCULATOR" },
];

/* ---------------------------------------------------------------- render */
function buildPinHTML(p, faces, bgDataUri) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<style>
  ${faces}
  *{margin:0;padding:0;box-sizing:border-box;font-synthesis:none}
  html,body{width:${PIN_W}px;height:${PIN_H}px}
  .pin{width:${PIN_W}px;height:${PIN_H}px;position:relative;overflow:hidden;
    background:${C.dark};font-family:'Oswald',sans-serif;-webkit-font-smoothing:antialiased}
  .bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
  /* Warm the photo slightly + darken so brand overlay carries the pin. */
  .tone{position:absolute;inset:0;background:
    radial-gradient(120% 80% at 50% 18%, rgba(237,120,24,.10), rgba(0,0,0,0) 60%),
    linear-gradient(180deg, rgba(28,20,13,.55) 0%, rgba(28,20,13,0) 26%)}
  .scrim{position:absolute;left:0;right:0;bottom:0;height:70%;background:
    linear-gradient(to top, ${C.dark} 0%, rgba(28,20,13,.985) 20%,
      rgba(28,20,13,.90) 42%, rgba(28,20,13,.55) 72%, rgba(28,20,13,0) 100%)}
  .brand{position:absolute;top:52px;left:64px;font-weight:600;font-size:31px;
    letter-spacing:.18em;color:${C.cream};text-transform:uppercase;
    text-shadow:0 2px 14px rgba(0,0,0,.6)}
  .brand b{color:${C.ember};font-weight:600}
  .tick{position:absolute;top:56px;right:64px;width:70px;height:22px;display:flex;gap:10px}
  .tick i{flex:1;background:${C.ember};opacity:.5}
  .tick i:last-child{opacity:1}
  .body{position:absolute;left:0;right:0;bottom:0;padding:0 64px 54px;
    display:flex;flex-direction:column;align-items:flex-start}
  .eyb{font-weight:600;font-size:31px;letter-spacing:.22em;text-transform:uppercase;
    color:${C.ember};margin-bottom:18px}
  .head{font-family:'Zilla Slab',Georgia,serif;font-weight:700;text-transform:uppercase;
    line-height:.94;font-size:96px;letter-spacing:-1px;color:${C.cream};
    text-shadow:0 3px 22px rgba(0,0,0,.55)}
  .accent{margin-top:26px;font-weight:500;font-size:35px;line-height:1.28;
    color:${C.cream};opacity:.92;max-width:850px}
  .cta{margin-top:40px;align-self:stretch;background:${C.ember};color:${C.dark};
    font-weight:600;font-size:37px;letter-spacing:.05em;text-align:center;
    padding:34px 28px;text-transform:uppercase}
  .foot{margin-top:28px;align-self:center;font-weight:500;font-size:27px;
    letter-spacing:.14em;color:${C.muted};text-transform:uppercase}
</style></head>
<body>
  <div class="pin">
    <img class="bg" src="${bgDataUri}" alt="">
    <div class="tone"></div>
    <div class="scrim"></div>
    <span class="brand">PITMASTER<b>.TOOLS</b></span>
    <span class="tick"><i></i><i></i><i></i></span>
    <div class="body">
      <div class="eyb">${esc(p.eyebrow)}</div>
      <div class="head">${headLines(p.head)}</div>
      <div class="accent">${esc(p.accent)}</div>
      <div class="cta">${esc(p.cta)}</div>
      <div class="foot">${esc(p.foot)}</div>
    </div>
  </div>
</body></html>`;
}

async function bgDataUriFor(slug) {
  for (const ext of ["jpg", "jpeg", "png", "webp"]) {
    try {
      const buf = await readFile(path.join(SRC, `${slug}.${ext}`));
      const mime = ext === "jpg" ? "jpeg" : ext;
      return `data:image/${mime};base64,${buf.toString("base64")}`;
    } catch { /* try next ext */ }
  }
  return null;
}

async function run() {
  let pins = PINS;
  if (args.only != null) {
    const only = String(args.only).split(",").filter(Boolean);
    const known = new Set(PINS.map((p) => p.slug));
    const unknown = only.filter((s) => !known.has(s));
    if (!only.length || unknown.length) {
      console.error("Unknown --only slug(s):", unknown.join(", ") || "(empty)");
      console.error("Valid slugs:", PINS.map((p) => p.slug).join(", "));
      process.exit(1);
    }
    pins = PINS.filter((p) => only.includes(p.slug));
  }

  await mkdir(OUT, { recursive: true });
  const faces = await fontFaceCss();
  const browser = await chromium.launch();
  let failed = 0;
  try {
    const page = await browser.newPage({
      viewport: { width: PIN_W, height: PIN_H },
      deviceScaleFactor: SCALE,
    });

    for (const p of pins) {
      try {
        const bg = await bgDataUriFor(p.slug);
        if (!bg) {
          failed++;
          console.error("missing source photo", `${SRC}/${p.slug}.(jpg|png|webp)`);
          continue;
        }
        await page.setContent(buildPinHTML(p, faces, bg), { waitUntil: "networkidle" });
        await page.evaluate(() => document.fonts.ready);
        // JPEG, not PNG: these are photographs, so PNG would be ~10x larger
        // (multi-MB) for no visual gain. Pinterest accepts JPG; q90 is visually
        // lossless for the overlay text at this size.
        const file = path.join(OUT, `${p.slug}.jpg`);
        await page.screenshot({ path: file, type: "jpeg", quality: 90, clip: { x: 0, y: 0, width: PIN_W, height: PIN_H } });
        console.log("rendered", file);
      } catch (e) {
        failed++;
        console.error("failed", p.slug, e.message);
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`\nDone. ${pins.length - failed}/${pins.length} pin(s) in ./${OUT} at ${PIN_W * SCALE}x${PIN_H * SCALE}.`);
  if (failed > 0) {
    console.error(`${failed} pin(s) failed to render.`);
    process.exitCode = 1;
  }
}

run();
