/**
 * render-campaign-pins.mjs
 * Render the 17 "fresh pin" creatives for the 30-day Pinterest launch campaign
 * (docs/pinterest-30-day-plan.md) as 1000x1500 PNGs under og/pins/.
 *
 * LOCAL / OFFLINE TOOL ONLY — same rules as render-pins.mjs: launches headless
 * Chromium (playwright devDep), never runs in build or deploy. Rendered PNGs
 * are committed; build.js copies og/ → dist/og/ recursively so they ship at
 * /og/pins/<slug>.png — the Media URLs in docs/pinterest-30-day-pins.csv.
 *
 * Run from the repo root:
 *   node scripts/render-campaign-pins.mjs              # → og/pins/*.png at 2x
 *   node scripts/render-campaign-pins.mjs --scale=1
 *   node scripts/render-campaign-pins.mjs --only=d15-brisket2
 *
 * These are campaign variants of pages that already have a pin image in og/ —
 * Pinterest treats a new image on a known URL as a fresh pin, so each creative
 * is deliberately laid out differently from the og/ cheat-sheet set (cream and
 * warm themes, illustrated SVG scenes instead of data tables).
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
const SCALE = Number(args.scale || 2);
const PIN_W = 1000;
const PIN_H = 1500;

// Brand palette (matches render-pins.mjs / site-base.css rebrand)
const C = {
  dark: "#26231F",
  cream: "#FBEED8",
  ember: "#ED7818",
  emberDeep: "#C0341E",
  muted: "#CDBFA6",
  mutedDark: "#8A7A5E",
  line: "#3A342D",
  lineCream: "#E4D3B4",
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

/* ---------------------------------------------------------------- SVG art */
// Every art fn returns an HTML string sized to fit the 880px-wide art zone.
// Geometric, flat, brand-palette illustrations — no external assets.

const flame = (fill = C.ember, w = 60) => `
<svg width="${w}" height="${w * 1.25}" viewBox="0 0 48 60" fill="none">
  <path d="M24 2C28 14 42 20 42 38a18 18 0 0 1-36 0C6 26 14 22 16 12c4 5 6 8 6 12 0-8 0-14 2-22z" fill="${fill}"/>
  <path d="M24 34c3 5 8 7 8 13a8 8 0 0 1-16 0c0-5 4-6 5-10 1 2 2 3 3 5 0-3 0-5 0-8z" fill="${C.cream}" opacity=".85"/>
</svg>`;

const smokeWisp = (stroke = C.muted) => `
<svg width="120" height="150" viewBox="0 0 120 150" fill="none">
  <path d="M60 145 C 30 115, 92 95, 60 65 C 34 42, 80 28, 62 5" stroke="${stroke}" stroke-width="9" stroke-linecap="round" opacity=".7"/>
</svg>`;

function artForecastWeek() {
  const days = [
    ["FRI", "A", true], ["SAT", "A", true], ["SUN", "B", false],
    ["MON", "C", false], ["TUE", "D", false], ["WED", "B", false], ["THU", "A", true],
  ];
  const cards = days
    .map(
      ([d, g, hot]) => `<div class="fc${hot ? " hot" : ""}">
        <span class="fcd">${d}</span><span class="fcg">${g}</span></div>`
    )
    .join("");
  return `
  <style>
    .fcrow{display:flex;gap:14px;justify-content:center}
    .fc{width:108px;padding:26px 0 22px;background:#2E2A25;border:3px solid ${C.line};
      display:flex;flex-direction:column;align-items:center;gap:10px}
    .fc.hot{background:${C.ember};border-color:${C.ember}}
    .fcd{font:600 26px 'Oswald';letter-spacing:.12em;color:${C.muted}}
    .fc.hot .fcd{color:${C.dark}}
    .fcg{font:700 64px 'Zilla Slab';color:${C.cream}}
    .fc.hot .fcg{color:${C.dark}}
    .fcap{margin-top:26px;text-align:center;font:500 30px 'Oswald';color:${C.muted};letter-spacing:.04em}
  </style>
  <div style="display:flex;justify-content:center;margin-bottom:6px">${smokeWisp()}</div>
  <div class="fcrow">${cards}</div>
  <div class="fcap">wind · rain · temp — graded for your backyard</div>`;
}

function artNightTimeline() {
  return `
  <style>
    .sky{position:relative;height:190px;margin:0 30px}
    .tl{display:flex;align-items:center;margin:30px 30px 0}
    .tl .seg{flex:1;height:10px;background:${C.line}}
    .tl .seg.lit{background:${C.ember}}
    .tl .node{width:34px;height:34px;border-radius:50%;background:${C.ember};flex:none}
    .tl .node.o{background:${C.cream}}
    .tlx{display:flex;justify-content:space-between;margin:22px 20px 0}
    .tlx div{width:200px;text-align:center;font:500 27px 'Oswald';color:${C.muted};line-height:1.25}
    .tlx b{display:block;font:600 34px 'Oswald';color:${C.cream};letter-spacing:.04em}
  </style>
  <div class="sky">
    <svg width="880" height="190" viewBox="0 0 880 190" fill="none">
      <circle cx="740" cy="80" r="58" fill="${C.cream}"/>
      <circle cx="716" cy="66" r="50" fill="${C.dark}"/>
      <circle cx="150" cy="50" r="5" fill="${C.cream}"/><circle cx="260" cy="110" r="4" fill="${C.muted}"/>
      <circle cx="380" cy="40" r="4" fill="${C.muted}"/><circle cx="480" cy="120" r="5" fill="${C.cream}"/>
      <circle cx="580" cy="55" r="4" fill="${C.muted}"/><circle cx="90 " cy="140" r="4" fill="${C.muted}"/>
    </svg>
  </div>
  <div class="tl">
    <span class="node"></span><span class="seg lit"></span>
    <span class="node"></span><span class="seg"></span><span class="node o"></span>
  </div>
  <div class="tlx">
    <div><b>6 PM</b>fire up</div>
    <div><b>2 AM</b>wrap it</div>
    <div><b>12 PM</b>slice &amp; serve</div>
  </div>`;
}

function artPeopleGrid() {
  const person = (hot) => `
    <svg width="72" height="86" viewBox="0 0 36 43">
      <circle cx="18" cy="10" r="9" fill="${hot ? C.ember : C.dark}" opacity="${hot ? 1 : 0.82}"/>
      <path d="M3 43 a15 16 0 0 1 30 0z" fill="${hot ? C.ember : C.dark}" opacity="${hot ? 1 : 0.82}"/>
    </svg>`;
  let cells = "";
  for (let i = 0; i < 20; i++) cells += `<span>${person(i < 4)}</span>`;
  return `
  <style>
    .ppl{display:grid;grid-template-columns:repeat(10,72px);gap:16px 12px;justify-content:center}
    .pstat{margin-top:34px;text-align:center;font:700 58px 'Zilla Slab';color:${C.emberDeep}}
    .pstat small{display:block;font:500 29px 'Oswald';color:${C.mutedDark};margin-top:8px;letter-spacing:.05em}
  </style>
  <div class="ppl">${cells}</div>
  <div class="pstat">≈ 20 LB RAW MEAT<small>½ lb cooked per guest, before sides</small></div>`;
}

function art321() {
  const block = (n, label, sub, hot) => `
    <div class="b321${hot ? " hot" : ""}">
      <span class="n">${n}</span><span class="l">${label}</span><span class="s">${sub}</span>
    </div>`;
  return `
  <style>
    .r321{display:flex;gap:22px;justify-content:center}
    .b321{width:260px;padding:40px 0 34px;background:#2E2A25;border-top:12px solid ${C.line};
      display:flex;flex-direction:column;align-items:center;gap:6px}
    .b321.hot{border-top-color:${C.ember}}
    .b321 .n{font:700 130px/1 'Zilla Slab';color:${C.cream}}
    .b321.hot .n{color:${C.ember}}
    .b321 .l{font:600 34px 'Oswald';letter-spacing:.14em;color:${C.cream};text-transform:uppercase}
    .b321 .s{font:400 26px 'Oswald';color:${C.muted}}
  </style>
  <div class="r321">
    ${block(3, "smoke", "hours in", true)}
    ${block(2, "wrap", "hours foiled", false)}
    ${block(1, "sauce", "hour glazed", false)}
  </div>`;
}

function artStallChart() {
  return `
  <style>.stw{position:relative;margin:0 20px}</style>
  <div class="stw">
    <svg width="840" height="430" viewBox="0 0 840 430" fill="none">
      <line x1="70" y1="20" x2="70" y2="370" stroke="${C.lineCream}" stroke-width="4"/>
      <line x1="70" y1="370" x2="820" y2="370" stroke="${C.lineCream}" stroke-width="4"/>
      <line x1="70" y1="150" x2="820" y2="150" stroke="${C.lineCream}" stroke-width="3" stroke-dasharray="14 12"/>
      <text x="80" y="128" font-family="Oswald" font-weight="600" font-size="34" fill="${C.mutedDark}">165°F</text>
      <path d="M70 360 C 170 330, 230 240, 300 170 L 620 158 C 700 130, 760 80, 810 40"
        stroke="${C.emberDeep}" stroke-width="12" fill="none" stroke-linecap="round"/>
      <rect x="330" y="196" width="262" height="64" rx="6" fill="${C.dark}"/>
      <text x="461" y="239" text-anchor="middle" font-family="Oswald" font-weight="600" font-size="32"
        fill="${C.cream}" letter-spacing="2">THE STALL</text>
      <text x="445" y="410" font-family="Oswald" font-weight="500" font-size="28" fill="${C.mutedDark}" text-anchor="middle">hours 5 – 9, going nowhere</text>
    </svg>
  </div>`;
}

function artRubRatio() {
  const bar = (label, parts, width, hot) => `
    <div class="rb">
      <span class="rl">${label}</span>
      <span class="rbar${hot ? " hot" : ""}" style="width:${width}px"></span>
      <span class="rn">${parts}</span>
    </div>`;
  return `
  <style>
    .rbs{display:flex;flex-direction:column;gap:30px;padding:0 40px}
    .rb{display:flex;align-items:center;gap:28px}
    .rl{width:170px;font:600 36px 'Oswald';letter-spacing:.1em;color:${C.dark};text-transform:uppercase}
    .rbar{height:64px;background:${C.dark};opacity:.85}
    .rbar.hot{background:${C.emberDeep};opacity:1}
    .rn{font:700 48px 'Zilla Slab';color:${C.emberDeep}}
    .rcap{margin-top:36px;text-align:center;font:500 30px 'Oswald';color:${C.mutedDark}}
  </style>
  <div class="rbs">
    ${bar("salt", "2 parts", 420, true)}
    ${bar("sugar", "1 part", 210, false)}
    ${bar("spice", "1 part", 210, false)}
  </div>
  <div class="rcap">keep the ratio — scale the batch to any cut</div>`;
}

function artGantt() {
  const row = (label, start, left, width, hot) => `
    <div class="g"><span class="gl">${label}</span>
      <span class="gtrack"><span class="gbar${hot ? " hot" : ""}" style="margin-left:${left}px;width:${width}px"></span></span>
      <span class="gs">${start}</span></div>`;
  return `
  <style>
    .gw{position:relative;padding:0 30px}
    .g{display:flex;align-items:center;gap:20px;margin-bottom:34px}
    .gl{width:160px;font:600 34px 'Oswald';letter-spacing:.06em;color:${C.cream};text-transform:uppercase}
    .gtrack{flex:1;position:relative;height:56px;background:#2E2A25}
    .gbar{display:block;height:56px;background:${C.muted}}
    .gbar.hot{background:${C.ember}}
    .gs{width:130px;font:500 30px 'Oswald';color:${C.muted}}
    .gline{position:absolute;right:190px;top:-16px;bottom:36px;width:6px;background:${C.cream}}
    .gcap{text-align:right;margin-right:130px;font:600 34px 'Oswald';color:${C.cream};letter-spacing:.08em}
  </style>
  <div class="gw">
    <div class="gline"></div>
    ${row("brisket", "4:00 AM", 0, 490, true)}
    ${row("ribs", "12:00 PM", 260, 230, false)}
    ${row("chicken", "4:30 PM", 400, 90, false)}
    <div class="gcap">→ ALL DONE AT 6 PM</div>
  </div>`;
}

function artSummerSun() {
  let rays = "";
  for (let i = 0; i < 12; i++) {
    const a = (i * 30 * Math.PI) / 180;
    const x1 = 440 + Math.cos(a) * 150, y1 = 210 + Math.sin(a) * 150;
    const x2 = 440 + Math.cos(a) * 200, y2 = 210 + Math.sin(a) * 200;
    rays += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${C.cream}" stroke-width="12" stroke-linecap="round"/>`;
  }
  return `
  <div style="display:flex;justify-content:center">
    <svg width="880" height="440" viewBox="0 0 880 440" fill="none">
      <circle cx="440" cy="210" r="115" fill="${C.cream}"/>
      ${rays}
      <rect x="330" y="330" width="220" height="76" rx="38" fill="${C.dark}"/>
      <text x="440" y="384" text-anchor="middle" font-family="Oswald" font-weight="600" font-size="46" fill="${C.cream}">95°F</text>
    </svg>
  </div>`;
}

function artPorkEquation() {
  const chip = (big, small, hot) => `
    <div class="pq${hot ? " hot" : ""}"><b>${big}</b><span>${small}</span></div>`;
  return `
  <style>
    .pqr{display:flex;align-items:center;justify-content:center;gap:18px}
    .pq{width:238px;padding:44px 0 38px;background:#fff6;border:4px solid ${C.lineCream};
      display:flex;flex-direction:column;align-items:center;gap:8px}
    .pq.hot{background:${C.emberDeep};border-color:${C.emberDeep}}
    .pq b{font:700 66px/1 'Zilla Slab';color:${C.dark}}
    .pq.hot b{color:${C.cream}}
    .pq span{font:500 27px 'Oswald';color:${C.mutedDark};letter-spacing:.04em}
    .pq.hot span{color:${C.cream};opacity:.85}
    .pqa{font:700 62px 'Zilla Slab';color:${C.emberDeep}}
    .pqcap{margin-top:34px;text-align:center;font:500 30px 'Oswald';color:${C.mutedDark}}
  </style>
  <div class="pqr">
    ${chip("8 LB", "raw butt", false)}<span class="pqa">→</span>
    ${chip("≈5 LB", "pulled pork", false)}<span class="pqa">→</span>
    ${chip("12", "sandwiches", true)}
  </div>
  <div class="pqcap">10–12 hours at 225°F — the calculator sets your start time</div>`;
}

function artCateringBreakdown() {
  const row = (l, r) => `<tr><td>${l}</td><td>${r}</td></tr>`;
  return `
  <style>
    .cthead{text-align:center;font:700 96px/1 'Zilla Slab';color:${C.cream}}
    .cthead small{display:block;font:600 32px 'Oswald';letter-spacing:.2em;color:${C.ember};margin-top:12px}
    .cttab{width:82%;margin:44px auto 0;border-collapse:collapse;font-family:'Oswald'}
    .cttab td{padding:22px 0;border-top:4px solid ${C.line};font-size:40px;color:${C.cream}}
    .cttab td:last-child{text-align:right;color:${C.ember};font-weight:600}
  </style>
  <div class="cthead">50 GUESTS<small>WHAT THE SMOKER OWES</small></div>
  <table class="cttab">
    ${row("Brisket", "20 lb raw")}
    ${row("Pork butt", "16 lb raw")}
    ${row("Chicken", "12 lb raw")}
  </table>`;
}

function artTempChips() {
  const chip = (cut, temp, hot) => `
    <div class="tc${hot ? " hot" : ""}"><span class="tcc">${cut}</span><span class="tct">${temp}</span></div>`;
  return `
  <style>
    .tcg{display:grid;grid-template-columns:1fr 1fr;gap:22px;padding:0 30px}
    .tc{padding:44px 0 40px;background:#fff6;border:4px solid ${C.lineCream};
      display:flex;flex-direction:column;align-items:center;gap:10px}
    .tc.hot{background:${C.dark};border-color:${C.dark}}
    .tcc{font:600 32px 'Oswald';letter-spacing:.16em;color:${C.mutedDark};text-transform:uppercase}
    .tc.hot .tcc{color:${C.muted}}
    .tct{font:700 84px/1 'Zilla Slab';color:${C.emberDeep}}
    .tc.hot .tct{color:${C.ember}}
  </style>
  <div class="tcg">
    ${chip("brisket", "203°F", true)}
    ${chip("pork butt", "203°F", false)}
    ${chip("chicken", "165°F", false)}
    ${chip("ribs", "BEND", false)}
  </div>`;
}

function artLeaderboard() {
  const pinIcon = `<svg width="34" height="46" viewBox="0 0 24 33"><path d="M12 0a12 12 0 0 1 12 12c0 9-12 21-12 21S0 21 0 12A12 12 0 0 1 12 0z" fill="${C.ember}"/><circle cx="12" cy="12" r="5" fill="${C.dark}"/></svg>`;
  const row = (rank, w, grade) => `
    <div class="lb"><span class="lbr">#${rank}</span>${pinIcon}
      <span class="lbbar" style="width:${w}px"></span><span class="lbg">${grade}</span></div>`;
  return `
  <style>
    .lbs{display:flex;flex-direction:column;gap:26px;padding:0 46px}
    .lb{display:flex;align-items:center;gap:24px}
    .lbr{width:80px;font:700 52px 'Zilla Slab';color:${C.cream}}
    .lbbar{height:52px;background:${C.ember};opacity:.92}
    .lb:nth-child(n+2) .lbbar{background:${C.muted};opacity:.55}
    .lbg{font:600 40px 'Oswald';color:${C.ember}}
    .lb:nth-child(n+2) .lbg{color:${C.muted}}
    .lbcap{margin-top:34px;text-align:center;font:500 30px 'Oswald';color:${C.muted}}
  </style>
  <div class="lbs">
    ${row(1, 470, "A+")}
    ${row(2, 420, "A")}
    ${row(3, 355, "A−")}
    ${row(4, 290, "B+")}
    ${row(5, 240, "B")}
  </div>
  <div class="lbcap">re-ranked from live forecasts — where's your city?</div>`;
}

function artSnakeMethod() {
  // Briquettes along a 250° arc inside the kettle rim; first few lit.
  let coals = "";
  const cx = 440, cy = 225, r = 165;
  for (let i = 0; i < 16; i++) {
    const a = ((125 + i * 17.5) * Math.PI) / 180;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    const lit = i < 3;
    coals += `<rect x="${x - 26}" y="${y - 20}" width="52" height="40" rx="10"
      transform="rotate(${125 + i * 17.5 + 90} ${x} ${y})"
      fill="${lit ? C.ember : C.cream}" opacity="${lit ? 1 : 0.9}"/>`;
  }
  return `
  <div style="display:flex;justify-content:center">
    <svg width="880" height="455" viewBox="0 0 880 455" fill="none">
      <circle cx="440" cy="225" r="212" stroke="${C.cream}" stroke-width="10" fill="#2E2A25"/>
      ${coals}
      <path d="M24 2C28 14 42 20 42 38a18 18 0 0 1-36 0C6 26 14 22 16 12c4 5 6 8 6 12 0-8 0-14 2-22z"
        fill="${C.ember}" transform="translate(295 300) scale(1.15)"/>
      <text x="440" y="238" text-anchor="middle" font-family="Oswald" font-weight="600" font-size="34"
        fill="${C.muted}" letter-spacing="3">LIGHT ONE END</text>
    </svg>
  </div>
  <div style="margin-top:26px;text-align:center;font:500 29px 'Oswald';color:${C.muted}">longer snake = longer cook — the calculator sizes it</div>`;
}

function artBrineBowl() {
  // salt grains falling into the bowl
  const grains = [
    [400, 30, 14, 20], [450, 55, 12, -15], [485, 25, 15, 40],
    [430, 80, 11, 65], [470, 105, 13, -30], [415, 125, 10, 10],
  ]
    .map(
      ([x, y, s, r]) =>
        `<rect x="${x}" y="${y}" width="${s}" height="${s}" rx="3" fill="${C.dark}" opacity=".8" transform="rotate(${r} ${x} ${y})"/>`
    )
    .join("");
  return `
  <div style="display:flex;justify-content:center">
    <svg width="880" height="400" viewBox="0 0 880 400" fill="none">
      ${grains}
      <path d="M190 160 h500 v80 a250 150 0 0 1 -500 0z" fill="#fff6" stroke="${C.lineCream}" stroke-width="6"/>
      <path d="M202 188 h476 v52 a238 138 0 0 1 -476 0z" fill="${C.emberDeep}" opacity=".25"/>
      <line x1="202" y1="188" x2="678" y2="188" stroke="${C.emberDeep}" stroke-width="6" opacity=".6"/>
      <circle cx="320" cy="240" r="9" fill="#fff" opacity=".8"/><circle cx="370" cy="270" r="7" fill="#fff" opacity=".8"/>
      <circle cx="540" cy="250" r="8" fill="#fff" opacity=".8"/><circle cx="575" cy="225" r="6" fill="#fff" opacity=".8"/>
      <text x="440" y="305" text-anchor="middle" font-family="Zilla Slab" font-weight="700" font-size="110" fill="${C.emberDeep}">5%</text>
    </svg>
  </div>
  <div style="margin:30px auto 0;width:520px;background:${C.dark};color:${C.cream};text-align:center;
    font:600 32px 'Oswald';letter-spacing:.06em;padding:20px 0">SALT · BY WEIGHT · WET OR DRY</div>`;
}

function artCostSplit() {
  const card = (tag, price, sub, hot) => `
    <div class="cs${hot ? " hot" : ""}"><span class="cst">${tag}</span>
      <span class="csp">${price}</span><span class="css">${sub}</span></div>`;
  return `
  <style>
    .csr{display:flex;gap:24px;justify-content:center}
    .cs{width:380px;padding:56px 0 48px;display:flex;flex-direction:column;align-items:center;gap:12px;
      background:#2E2A25;border:4px solid ${C.line}}
    .cs.hot{background:${C.ember};border-color:${C.ember}}
    .cst{font:600 30px 'Oswald';letter-spacing:.18em;color:${C.muted};text-transform:uppercase}
    .cs.hot .cst{color:${C.dark}}
    .csp{font:700 130px/1 'Zilla Slab';color:${C.cream}}
    .cs.hot .csp{color:${C.dark}}
    .css{font:500 28px 'Oswald';color:${C.muted}}
    .cs.hot .css{color:${C.dark};opacity:.8}
  </style>
  <div class="csr">
    ${card("restaurant", "$28", "per plate, plus tip", false)}
    ${card("your backyard", "$9", "per plate, all in", true)}
  </div>`;
}

function artToolGrid() {
  const icons = {
    flame: `<path d="M24 4C27 13 38 18 38 31a14 14 0 0 1-28 0C10 22 16 19 18 11c3 4 5 6 5 9 0-6 0-11 1-16z"/>`,
    clock: `<circle cx="24" cy="24" r="18" fill="none" stroke-width="5" stroke="currentColor"/><path d="M24 13v11l8 6" fill="none" stroke-width="5" stroke="currentColor" stroke-linecap="round"/>`,
    therm: `<rect x="19" y="6" width="10" height="24" rx="5"/><circle cx="24" cy="36" r="9"/>`,
    people: `<circle cx="16" cy="15" r="7"/><path d="M4 40a12 12 0 0 1 24 0z"/><circle cx="34" cy="17" r="6"/><path d="M26 40a10 10 0 0 1 18 0z" opacity=".7"/>`,
    scale: `<rect x="8" y="8" width="32" height="32" rx="6" fill="none" stroke-width="5" stroke="currentColor"/><path d="M24 8v14l9-7" fill="none" stroke-width="5" stroke="currentColor" stroke-linecap="round"/>`,
    dollar: `<path d="M24 6v36M33 13c-2-3-16-5-16 4 0 8 16 5 16 13 0 9-14 7-17 3" fill="none" stroke-width="5" stroke="currentColor" stroke-linecap="round"/>`,
    drop: `<path d="M24 4C30 16 38 22 38 32a14 14 0 0 1-28 0C10 22 18 16 24 4z"/>`,
    cloud: `<path d="M14 34a9 9 0 0 1 2-17.8A11 11 0 0 1 37 19a8 8 0 0 1-1 15.9z"/>`,
    meat: `<ellipse cx="22" cy="26" rx="16" ry="12"/><circle cx="36" cy="16" r="7" fill="none" stroke-width="5" stroke="currentColor"/>`,
    cal: `<rect x="7" y="10" width="34" height="30" rx="4" fill="none" stroke-width="5" stroke="currentColor"/><path d="M7 20h34M16 6v8M32 6v8" stroke-width="5" stroke="currentColor"/>`,
    wind: `<path d="M6 18h24a6 6 0 1 0-6-8M6 28h30a6 6 0 1 1-6 8" fill="none" stroke-width="5" stroke="currentColor" stroke-linecap="round"/>`,
    star: `<path d="M24 4l6 13 14 2-10 10 2 14-12-7-12 7 2-14L4 19l14-2z"/>`,
  };
  const keys = Object.keys(icons);
  const tiles = keys
    .map(
      (k, i) => `<div class="tile${i === 0 ? " hot" : ""}">
        <svg width="62" height="62" viewBox="0 0 48 48" fill="currentColor">${icons[k]}</svg></div>`
    )
    .join("");
  return `
  <style>
    .tgrid{display:grid;grid-template-columns:repeat(4,178px);gap:22px;justify-content:center}
    .tile{height:150px;display:flex;align-items:center;justify-content:center;
      background:#2E2A25;border:3px solid ${C.line};color:${C.muted}}
    .tile.hot{background:${C.ember};border-color:${C.ember};color:${C.dark}}
  </style>
  <div class="tgrid">${tiles}</div>`;
}

function artFlatVsPacker() {
  return `
  <style>
    .fvp{display:flex;gap:26px;justify-content:center;align-items:flex-end}
    .fv{display:flex;flex-direction:column;align-items:center;gap:18px}
    .fvl{font:600 34px 'Oswald';letter-spacing:.14em;color:${C.dark};text-transform:uppercase}
    .fvt{font:700 52px 'Zilla Slab';color:${C.emberDeep}}
    .fvs{font:500 28px 'Oswald';color:${C.mutedDark}}
  </style>
  <div class="fvp">
    <div class="fv">
      <svg width="330" height="150" viewBox="0 0 330 150"><rect x="15" y="55" width="300" height="80" rx="34" fill="${C.dark}" opacity=".85"/></svg>
      <span class="fvl">flat · 6 lb</span><span class="fvt">~9 HR</span><span class="fvs">thin — watch it</span>
    </div>
    <div class="fv">
      <svg width="430" height="230" viewBox="0 0 430 230">
        <path d="M25 150 C 15 90, 90 45, 190 40 C 300 34, 415 70, 415 125 C 415 185, 330 210, 210 208 C 100 206, 32 195, 25 150z" fill="${C.emberDeep}"/>
      </svg>
      <span class="fvl">packer · 14 lb</span><span class="fvt">~18 HR</span><span class="fvs">thick point — plan overnight</span>
    </div>
  </div>`;
}

/* -------------------------------------------------------------- pin specs */
// theme: dark (charcoal), cream (inverted), warm (ember gradient)
const PINS = [
  {
    slug: "d13-smokeweather", theme: "dark",
    eyebrow: "This weekend?", head: "Is it a\nsmoke day?",
    art: artForecastWeek,
    cta: "Check your 7-day forecast →", foot: "FREE SMOKE-DAY FORECAST",
  },
  {
    slug: "d15-brisket2", theme: "dark",
    eyebrow: "Overnight cook", head: "Brisket\nsleep math",
    art: artNightTimeline,
    cta: "Get your fire-up time →", foot: "FREE BRISKET CALCULATOR",
  },
  {
    slug: "d16-meatpp2", theme: "cream",
    eyebrow: "Party of 20", head: "How much\nto buy?",
    art: artPeopleGrid,
    cta: "Calculate for your crowd →", foot: "FREE SERVING CALCULATOR",
  },
  {
    slug: "d17-ribs2", theme: "dark",
    eyebrow: "The classic method", head: "The 3-2-1\nrib clock",
    art: art321,
    cta: "Get your exact stage times →", foot: "FREE RIB CALCULATOR",
  },
  {
    slug: "d18-stall", theme: "cream",
    eyebrow: "Don't panic", head: "Stuck at\n165°F?",
    art: artStallChart,
    cta: "Read: the stall, explained →", foot: "FREE BBQ GUIDES",
  },
  {
    slug: "d19-rub2", theme: "cream",
    eyebrow: "Stop eyeballing it", head: "The rub\nratio",
    art: artRubRatio,
    cta: "Scale your rub →", foot: "FREE DRY RUB CALCULATOR",
  },
  {
    slug: "d20-coordinator2", theme: "dark",
    eyebrow: "Multi-meat timing", head: "All done\nat 6 PM",
    art: artGantt,
    cta: "Build your schedule →", foot: "FREE COOK COORDINATOR",
  },
  {
    slug: "d21-summer", theme: "warm",
    eyebrow: "National grilling month", head: "Summer\nsmoking\nguide",
    art: artSummerSun,
    cta: "Heat, humidity & your smoker →", foot: "SEASONAL SMOKING GUIDES",
  },
  {
    slug: "d22-porkbutt2", theme: "cream",
    eyebrow: "Pulled pork math", head: "One butt\nfeeds 12",
    art: artPorkEquation,
    cta: "Get your cook time →", foot: "FREE PORK CALCULATOR",
  },
  {
    slug: "d23-catering2", theme: "dark",
    eyebrow: "Reunion season", head: "Feed them\nall",
    art: artCateringBreakdown,
    cta: "Plan your whole menu →", foot: "FREE CATERING CALCULATOR",
  },
  {
    slug: "d24-chart2", theme: "cream",
    eyebrow: "Memorize these", head: "Pull temps\nthat matter",
    art: artTempChips,
    cta: "See the full chart →", foot: "FREE TIMES & TEMPS CHART",
  },
  {
    slug: "d25-bestcities", theme: "dark",
    eyebrow: "50 cities, ranked", head: "Best smoking\nweather in\nAmerica",
    art: artLeaderboard,
    cta: "See the leaderboard →", foot: "SMOKE-WEATHER LEADERBOARD",
  },
  {
    slug: "d26-charcoal2", theme: "dark",
    eyebrow: "Set & forget", head: "The snake\nmethod",
    art: artSnakeMethod,
    cta: "Count your briquettes →", foot: "FREE CHARCOAL CALCULATOR",
  },
  {
    slug: "d27-brine2", theme: "cream",
    eyebrow: "Juicy every time", head: "Never dry\nchicken\nagain",
    art: artBrineBowl,
    cta: "Build your brine →", foot: "FREE BRINE CALCULATOR",
  },
  {
    slug: "d28-cost2", theme: "dark",
    eyebrow: "Run the numbers", head: "The real\ncost of BBQ",
    art: artCostSplit,
    cta: "Calculate your cost per plate →", foot: "FREE BBQ COST CALCULATOR",
  },
  {
    slug: "d29-toolshub", theme: "dark",
    eyebrow: "The whole toolbox", head: "13 free BBQ\ncalculators",
    art: artToolGrid,
    cta: "All free · no signup →", foot: "PITMASTER.TOOLS",
  },
  {
    slug: "d30-brisket3", theme: "cream",
    eyebrow: "Know your cut", head: "Flat vs\npacker",
    art: artFlatVsPacker,
    cta: "Get timing for your cut →", foot: "FREE BRISKET CALCULATOR",
  },
];

/* ---------------------------------------------------------------- render */
function buildPinHTML(p, faces) {
  const t = p.theme;
  const bg =
    t === "warm"
      ? `background:linear-gradient(160deg,#C0341E,#7A2412)`
      : t === "cream"
        ? `background:${C.cream}`
        : `background:${C.dark}`;
  const fg = t === "cream" ? C.dark : C.cream;
  const accent = t === "warm" ? C.cream : t === "cream" ? C.emberDeep : C.ember;
  const footCol = t === "cream" ? C.mutedDark : t === "warm" ? C.cream : "#9A8D74";
  const ctaBg = t === "warm" ? C.dark : t === "cream" ? C.dark : C.ember;
  const ctaFg = t === "warm" ? C.cream : t === "cream" ? C.cream : C.dark;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<style>
  ${faces}
  *{margin:0;padding:0;box-sizing:border-box;font-synthesis:none}
  html,body{width:${PIN_W}px;height:${PIN_H}px}
  .pin{width:${PIN_W}px;height:${PIN_H}px;position:relative;overflow:hidden;${bg};color:${fg};
    display:flex;flex-direction:column;font-family:'Oswald',sans-serif;-webkit-font-smoothing:antialiased}
  .brand{position:absolute;top:50px;left:60px;font-weight:600;font-size:31px;
    letter-spacing:.18em;color:${accent};text-transform:uppercase}
  .tick{position:absolute;top:54px;right:60px;width:70px;height:24px;display:flex;gap:10px}
  .tick i{flex:1;background:${accent};opacity:.5}
  .tick i:last-child{opacity:1}
  .body{flex:1;display:flex;flex-direction:column;justify-content:center;padding:120px 60px 0}
  .eyb{font-weight:600;font-size:30px;letter-spacing:.22em;text-transform:uppercase;
    color:${accent};margin-bottom:22px}
  .head{font-family:'Zilla Slab',Georgia,serif;font-weight:700;text-transform:uppercase;
    line-height:.96;font-size:88px;letter-spacing:-.5px;margin-bottom:52px}
  .art{margin-bottom:10px}
  .cta{margin:44px 60px 56px;background:${ctaBg};color:${ctaFg};font-weight:600;font-size:37px;
    letter-spacing:.06em;text-align:center;padding:36px;text-transform:uppercase}
  .foot{padding:0 60px 50px;font-weight:500;font-size:28px;letter-spacing:.1em;
    color:${footCol};text-align:center;text-transform:uppercase}
</style></head>
<body>
  <div class="pin">
    <span class="brand">PITMASTER.TOOLS</span>
    <span class="tick"><i></i><i></i><i></i></span>
    <div class="body">
      <div class="eyb">${esc(p.eyebrow)}</div>
      <div class="head">${headLines(p.head)}</div>
      <div class="art">${p.art()}</div>
    </div>
    <div class="cta">${esc(p.cta)}</div>
    <div class="foot">${esc(p.foot)}</div>
  </div>
</body></html>`;
}

async function run() {
  let pins = PINS;
  if (args.only != null) {
    // Strict matching: a typo'd or empty slug must error, not silently render
    // a different set than the operator asked for.
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
        await page.setContent(buildPinHTML(p, faces), { waitUntil: "networkidle" });
        await page.evaluate(() => document.fonts.ready);
        const file = path.join(OUT, `${p.slug}.png`);
        await page.screenshot({ path: file, clip: { x: 0, y: 0, width: PIN_W, height: PIN_H } });
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
  // Fail loudly so a partial render (stale og/pins/<slug>.png) can't pass
  // silently — same contract as render-pins.mjs.
  if (failed > 0) {
    console.error(`${failed} pin(s) failed to render.`);
    process.exitCode = 1;
  }
}

run();
