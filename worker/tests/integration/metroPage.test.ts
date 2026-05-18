import { env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleMetroPage } from '../../src/handlers/metroPage';
import { etDayBucket } from '../../src/lib/cache/weather';
import { applyMigrations } from '../helpers/d1';
import { installFetchStub, jsonResponse, type FetchStub } from '../helpers/fetchStub';
import { buildContext } from '../helpers/routeContext';

interface E {
  WEATHER_KV: KVNamespace;
  SMOKE_DB: D1Database;
}
const KV = (env as unknown as E).WEATHER_KV;
const DB = (env as unknown as E).SMOKE_DB;

beforeAll(async () => {
  await applyMigrations(DB);
});

let stub: FetchStub | null = null;

// Minimal HTML template that the Worker rewrites. Has the three
// anchors handleMetroPage targets: #verdictHero, #dayCards,
// #affiliateSlot. Real per-metro pages have much more chrome around
// these but the SSR handler only touches these three.
const TEMPLATE_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>Atlanta, GA BBQ Forecast</title></head>
<body>
<main>
  <section class="verdict-hero" id="verdictHero" hidden></section>
  <div id="dayCards" class="day-cards"></div>
  <aside id="affiliateSlot" class="affiliate-card" hidden></aside>
</main>
</body>
</html>`;

function makeAssets(html: string): Fetcher {
  return {
    async fetch() {
      return new Response(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    },
  } as unknown as Fetcher;
}

beforeEach(async () => {
  // Wipe both today's weather cache and yesterday's so the test's
  // forecast fetch goes through the (stubbed) Open-Meteo path
  // deterministically.
  const today = etDayBucket();
  await KV.delete(`weather:v2:30303:${today}`);
  await KV.delete(`geo:v3:30303`);
});
afterEach(() => {
  stub?.restore();
  stub = null;
});

const openMeteoOk = () =>
  jsonResponse(200, {
    daily: {
      time: ['2026-05-18', '2026-05-19', '2026-05-20', '2026-05-21', '2026-05-22', '2026-05-23', '2026-05-24'],
      temperature_2m_max: [82, 80, 78, 75, 88, 70, 72],
      temperature_2m_min: [60, 58, 56, 55, 60, 50, 52],
      relative_humidity_2m_mean: [55, 58, 62, 50, 70, 45, 50],
      wind_speed_10m_max: [8, 7, 6, 5, 14, 4, 5],
      wind_gusts_10m_max: [12, 10, 8, 7, 20, 6, 8],
      precipitation_probability_max: [10, 5, 0, 0, 60, 0, 5],
      precipitation_sum: [0, 0, 0, 0, 0.3, 0, 0],
      dew_point_2m_mean: [50, 49, 48, 47, 60, 42, 44],
    },
    hourly: {
      time: ['2026-05-18T00:00', '2026-05-18T12:00'],
      temperature_2m: [60, 78],
      relative_humidity_2m: [70, 50],
      wind_speed_10m: [4, 8],
      wind_gusts_10m: [6, 12],
      precipitation_probability: [5, 10],
      precipitation: [0, 0],
      dew_point_2m: [50, 50],
    },
  });

describe('handleMetroPage', () => {
  it('renders verdictHero + dayCards + affiliate slot for a known metro slug', async () => {
    stub = installFetchStub([{ match: 'api.open-meteo.com/v1/forecast', respond: openMeteoOk }]);
    const rc = buildContext(
      new Request('https://x/smoke-weather/atlanta-ga'),
      { slug: 'atlanta-ga' },
      { ASSETS: makeAssets(TEMPLATE_HTML) }
    );
    const res = await handleMetroPage(rc);
    expect(res.status).toBe(200);
    const body = await res.text();

    // Verdict hero is no longer hidden, carries a band-* class, and
    // contains the location line.
    expect(body).toMatch(/<section class="verdict-hero band-(red|yellow|green|ideal)" id="verdictHero">/);
    expect(body).not.toMatch(/<section class="verdict-hero" id="verdictHero" hidden>/);
    expect(body).toMatch(/Forecast for <strong>Atlanta, GA<\/strong>/);
    // ZIP from the metros table fast-path (Atlanta = 30303).
    expect(body).toMatch(/ZIP 30303/);

    // Day cards container filled with 7 articles.
    const articles = body.match(/<article class="day-card band-/g) ?? [];
    expect(articles.length).toBe(7);
    // /100 suffix appears 7 times (one per card).
    expect((body.match(/day-card__score-suffix">\/100/g) ?? []).length).toBe(7);

    // SSR-context JSON island is dropped inside <main>.
    expect(body).toMatch(/<script id="ssr-context" type="application\/json">/);
    expect(body).toMatch(/"cut":"brisket-packer"/);
    expect(body).toMatch(/"cooker":"offset"/);

    // Cache-Control allows CDN to cache aggressively.
    expect(res.headers.get('Cache-Control')).toMatch(/public.*s-maxage=\d+/);
  });

  it('falls through to ASSETS unchanged for known reserved slugs (methodology, faq, …)', async () => {
    const assetBody = '<html><body><h1>Methodology</h1></body></html>';
    stub = installFetchStub([]); // forecast endpoints should not be called
    const rc = buildContext(
      new Request('https://x/smoke-weather/methodology'),
      { slug: 'methodology' },
      { ASSETS: makeAssets(assetBody) }
    );
    const res = await handleMetroPage(rc);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(assetBody);
    // We should never have called the upstream forecast for a non-metro
    // slug.
    expect(stub.calls.length).toBe(0);
  });

  it('falls through to ASSETS unchanged for unknown slugs', async () => {
    const assetBody = '<html><body>404</body></html>';
    stub = installFetchStub([]);
    const rc = buildContext(
      new Request('https://x/smoke-weather/does-not-exist'),
      { slug: 'does-not-exist' },
      { ASSETS: makeAssets(assetBody) }
    );
    const res = await handleMetroPage(rc);
    expect(await res.text()).toBe(assetBody);
    expect(stub.calls.length).toBe(0);
  });

  it('falls through to ASSETS when forecast fetch fails for a known metro', async () => {
    // Both upstream weather sources fail; the handler should serve the
    // static template (so the page still works, with client JS as the
    // fallback render path).
    stub = installFetchStub([
      { match: 'api.open-meteo.com/v1/forecast', respond: () => jsonResponse(503, {}) },
      { match: 'api.weather.gov', respond: () => jsonResponse(503, {}) },
    ]);
    const rc = buildContext(
      new Request('https://x/smoke-weather/atlanta-ga'),
      { slug: 'atlanta-ga' },
      { ASSETS: makeAssets(TEMPLATE_HTML) }
    );
    const res = await handleMetroPage(rc);
    expect(res.status).toBe(200);
    const body = await res.text();
    // Template comes back unchanged (verdictHero still hidden, dayCards empty).
    expect(body).toMatch(/<section class="verdict-hero" id="verdictHero" hidden>/);
    expect(body).toMatch(/<div id="dayCards" class="day-cards"><\/div>/);
  });
});
