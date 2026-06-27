#!/usr/bin/env node
/**
 * generate-normals.mjs — emit data/metro-normals.json: 12 monthly climate
 * normals per Best-Smoke-Days metro, used by scripts/generate-metros.js to
 * render the per-metro climate-normals table + Dataset schema.
 *
 * LOCAL / OFFLINE DEV TOOL ONLY. This makes ~150 network calls (NCEI + Open-
 * Meteo). It must NEVER run in the build or deploy pipeline — generate-metros.js
 * reads the committed JSON, it does not fetch. Re-run yearly (or when the metro
 * list changes) and commit the refreshed data/metro-normals.json.
 *
 * Hybrid sources (NOAA monthly normals carry no wind/humidity, and NOAA hourly
 * normals are missing for several metro airports — so wind/humidity come from a
 * reanalysis archive instead):
 *   - avg_high_f / avg_low_f / precip_days  → NOAA NCEI 1991-2020 *Monthly*
 *     Normals (MLY-TMAX-NORMAL / MLY-TMIN-NORMAL / MLY-PRCP-AVGNDS-GE010HI),
 *     nearest airport (USW) / first-order station, auto-selected per metro.
 *   - avg_wind_mph / avg_humidity → Open-Meteo historical archive (ERA5),
 *     daily means over OM_START..OM_END aggregated by calendar month, at the
 *     metro lat/lon (no station mapping).
 *
 * The monthly smoke_score is NOT stored here — it is derived at render time in
 * generate-metros.js via the shared WeatherScore.scoreDay engine, so it always
 * tracks the current scoring model. This file holds only measured facts.
 *
 * Usage (from repo root, Node 18+):
 *   node scripts/generate-normals.mjs                 # all 50 metros
 *   node scripts/generate-normals.mjs --only=austin-tx,houston-tx
 *   node scripts/generate-normals.mjs --no-cache      # ignore .tmp cache
 */

import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);
const { METROS } = require('./generate-metros.js');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

const OUT_FILE = path.join('data', 'metro-normals.json');
const CACHE_DIR = path.join('.tmp', 'normals-cache');
const USE_CACHE = !args['no-cache'];

// Open-Meteo aggregation window — 10 full calendar years. ERA5 archive lags
// ~5 days behind real time, so we end on a completed year to keep monthly
// means stable and reproducible.
const OM_START = '2015-01-01';
const OM_END = '2024-12-31';
const NOAA_PERIOD = '1991-2020';

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// ── tiny helpers ─────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function haversineMi(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function round(n, places = 1) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

// Cached, retrying JSON fetch. Cache key is a filesystem-safe hash of the URL.
async function getJson(url, label) {
  const key = label.replace(/[^a-z0-9]+/gi, '_').slice(0, 80) + '.json';
  const cachePath = path.join(CACHE_DIR, key);
  if (USE_CACHE && existsSync(cachePath)) {
    return JSON.parse(readFileSync(cachePath, 'utf8'));
  }
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'pitmaster.tools normals seed (contact@pitmaster.tools)' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(cachePath, JSON.stringify(data));
      return data;
    } catch (err) {
      lastErr = err;
      if (attempt < 4) await sleep(attempt * 1500);
    }
  }
  throw new Error(`fetch failed for ${label}: ${lastErr && lastErr.message}`);
}

// ── NOAA: pick nearest station, then pull monthly normals ──────────────────

const NCEI = 'https://www.ncei.noaa.gov/access/services';

// Find candidate 1991-2020 monthly-normals stations near (lat, lon), ordered
// by distance, airport (USW) stations first. Widens the search box until it
// finds candidates.
async function findStationCandidates(slug, lat, lon) {
  for (const halfDeg of [0.9, 1.8, 3.0]) {
    const bbox = `${(lat + halfDeg).toFixed(4)},${(lon - halfDeg).toFixed(4)},${(lat - halfDeg).toFixed(4)},${(lon + halfDeg).toFixed(4)}`;
    const url =
      `${NCEI}/search/v1/data?dataset=normals-monthly-1991-2020` +
      `&bbox=${encodeURIComponent(bbox)}&dataTypes=MLY-TMAX-NORMAL&limit=1000`;
    const data = await getJson(url, `search_${slug}_${halfDeg}`);
    const results = (data && data.results) || [];
    const cands = [];
    for (const r of results) {
      const coords = r.location && r.location.coordinates; // [lon, lat]
      // r.id is the archive-member path; the clean GHCN id lives on the
      // nested station record.
      const id = r.stations && r.stations[0] && r.stations[0].id;
      if (!id || !coords || !/^US\w\d+$/.test(id)) continue;
      const [slon, slat] = coords;
      cands.push({
        id,
        name: (r.stations[0].name || id).replace(/\s+US$/, ''),
        lat: slat,
        lon: slon,
        distMi: haversineMi(lat, lon, slat, slon),
        airport: id.startsWith('USW'),
      });
    }
    if (cands.length) {
      // Airport stations first, then by distance.
      cands.sort((a, b) => (b.airport - a.airport) || (a.distMi - b.distMi));
      return cands;
    }
  }
  return [];
}

// Pull the 12-month TMAX/TMIN/precip-days normals for one station. Returns
// null unless all 12 months carry both temperature normals. `hasPrecip` flags
// whether precip-days is also complete (some co-op/airport stations omit it),
// so the caller can prefer a station with the full set.
async function fetchMonthlyNormals(station) {
  const url =
    `${NCEI}/data/v1?dataset=normals-monthly-1991-2020&stations=${station.id}` +
    `&dataTypes=MLY-TMAX-NORMAL,MLY-TMIN-NORMAL,MLY-PRCP-AVGNDS-GE010HI` +
    `&format=json&units=standard`;
  const rows = await getJson(url, `monthly_${station.id}`);
  if (!Array.isArray(rows) || rows.length === 0) return null;
  // A finite value above NCEI's -9999 missing sentinel, else null. Guards the
  // absent-field case too: parseFloat(undefined) is NaN, and NaN passes a
  // `<= -999` test, which would otherwise mark a missing field as present.
  const val = (raw) => {
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) && n > -999 ? n : null;
  };
  const byMonth = new Map();
  for (const row of rows) {
    const m = Number.parseInt(row.DATE, 10); // "01".."12"
    if (!m) continue;
    byMonth.set(m, {
      high: val(row['MLY-TMAX-NORMAL']),
      low: val(row['MLY-TMIN-NORMAL']),
      pdays: val(row['MLY-PRCP-AVGNDS-GE010HI']),
    });
  }
  let hasPrecip = true;
  for (let m = 1; m <= 12; m++) {
    const v = byMonth.get(m);
    if (!v || v.high == null || v.low == null) return null; // incomplete — caller tries next candidate
    if (v.pdays == null) hasPrecip = false;
  }
  return { byMonth, hasPrecip };
}

// ── Open-Meteo: daily wind + humidity means → monthly means ────────────────

async function fetchWindHumidity(slug, lat, lon) {
  const url =
    `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
    `&start_date=${OM_START}&end_date=${OM_END}` +
    `&daily=wind_speed_10m_mean,relative_humidity_2m_mean` +
    `&wind_speed_unit=mph&timezone=UTC`;
  const data = await getJson(url, `openmeteo_${slug}`);
  const daily = data && data.daily;
  if (!daily || !Array.isArray(daily.time)) {
    throw new Error(`Open-Meteo returned no daily data for ${slug}`);
  }
  const windSum = Array(13).fill(0);
  const windN = Array(13).fill(0);
  const rhSum = Array(13).fill(0);
  const rhN = Array(13).fill(0);
  for (let i = 0; i < daily.time.length; i++) {
    const m = Number.parseInt(daily.time[i].slice(5, 7), 10);
    const w = daily.wind_speed_10m_mean[i];
    const h = daily.relative_humidity_2m_mean[i];
    if (Number.isFinite(w)) { windSum[m] += w; windN[m]++; }
    if (Number.isFinite(h)) { rhSum[m] += h; rhN[m]++; }
  }
  const out = new Map();
  for (let m = 1; m <= 12; m++) {
    out.set(m, {
      wind: windN[m] ? windSum[m] / windN[m] : null,
      rh: rhN[m] ? rhSum[m] / rhN[m] : null,
    });
  }
  return out;
}

// ── per-metro assembly ─────────────────────────────────────────────────────

async function buildMetro(metro) {
  const { slug, latitude: lat, longitude: lon } = metro;
  const candidates = await findStationCandidates(slug, lat, lon);
  if (!candidates.length) throw new Error(`no NOAA normals station near ${slug}`);

  // Prefer the nearest station with a COMPLETE set (temp + precip-days);
  // fall back to the nearest temp-only station so a metro is never dropped.
  let station = null;
  let monthly = null;
  let fallback = null;
  for (const cand of candidates.slice(0, 8)) {
    const m = await fetchMonthlyNormals(cand);
    if (!m) continue;
    if (m.hasPrecip) { station = cand; monthly = m.byMonth; break; }
    if (!fallback) fallback = { station: cand, byMonth: m.byMonth };
  }
  if (!monthly && fallback) {
    console.warn(`  (no nearby station with precip-days for ${slug}; using ${fallback.station.id} temp-only)`);
    station = fallback.station;
    monthly = fallback.byMonth;
  }
  if (!monthly) throw new Error(`no complete monthly normals among nearest stations for ${slug}`);

  const wh = await fetchWindHumidity(slug, lat, lon);

  const months = [];
  for (let m = 1; m <= 12; m++) {
    const t = monthly.get(m);
    const w = wh.get(m);
    months.push({
      month: m,
      avg_high_f: round(t.high, 1),
      avg_low_f: round(t.low, 1),
      avg_wind_mph: round(w.wind, 1),
      avg_humidity: round(w.rh, 0),
      precip_days: round(t.pdays, 1),
    });
  }

  return {
    station: {
      id: station.id,
      name: station.name,
      latitude: round(station.lat, 4),
      longitude: round(station.lon, 4),
      distance_mi: round(station.distMi, 1),
    },
    sources: {
      temperature_precip: { provider: 'NOAA NCEI U.S. Climate Normals', period: NOAA_PERIOD },
      wind_humidity: { provider: 'Open-Meteo historical archive (ERA5)', period: `${OM_START.slice(0, 4)}-${OM_END.slice(0, 4)}` },
    },
    months,
  };
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  const only = typeof args.only === 'string' ? new Set(args.only.split(',')) : null;
  const metros = only ? METROS.filter((m) => only.has(m.slug)) : METROS;
  if (!metros.length) {
    console.error('generate-normals: no metros matched --only filter');
    process.exit(1);
  }

  // Preserve existing entries when running a partial (--only) refresh.
  const out = (only && existsSync(OUT_FILE)) ? JSON.parse(readFileSync(OUT_FILE, 'utf8')) : {};

  let done = 0;
  for (const metro of metros) {
    process.stdout.write(`[${++done}/${metros.length}] ${metro.slug} … `);
    try {
      out[metro.slug] = await buildMetro(metro);
      const st = out[metro.slug].station;
      console.log(`${st.id} ${st.name} (${st.distance_mi} mi)`);
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
      throw err; // a missing metro must fail the run, not ship a hole
    }
    await sleep(300); // be polite to NCEI / Open-Meteo
  }

  // Stable key order (sorted by slug) for clean diffs.
  const sorted = {};
  for (const slug of Object.keys(out).sort()) sorted[slug] = out[slug];

  mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(sorted, null, 2) + '\n');
  console.log(`\ngenerate-normals: wrote ${Object.keys(sorted).length} metros → ${OUT_FILE}`);
}

main().catch((err) => {
  console.error('\ngenerate-normals: ' + (err && err.stack || err));
  process.exit(1);
});
