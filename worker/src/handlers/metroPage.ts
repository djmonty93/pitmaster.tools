// GET /smoke-weather/:slug
//
// Server-side renders the per-metro forecast page. For a recognized
// metro slug:
//   1. Resolve the metro's zip/coords via D1 (`metros` table).
//   2. Read today's forecast from KV (pre-warmed by the nightly cron;
//      cold-start path falls through to fetchForecastCached's adapter
//      so we never serve an empty page).
//   3. Score every day at the default cut/cooker (brisket-packer /
//      offset — the most demanding combination).
//   4. Fetch the static HTML template from ASSETS.
//   5. Use HTMLRewriter to fill #verdictHero, #dayCards, and (when
//      applicable) #affiliateSlot with rendered HTML, plus an
//      `<script id="ssr-context">` JSON island so the client can skip
//      its initial fetch when the user's saved cut/cooker matches the
//      SSR's defaults.
//   6. Return the rewritten response with a Cache-Control that lets
//      the CDN cache for the rest of the ET day (the next 00:00 ET
//      tick rewrites the underlying KV data; the CDN entry refreshes
//      on its own clock but the worst case is a few hours of staleness
//      against KV — acceptable since the data behind the day rarely
//      changes after midnight).
//
// For unknown slugs (methodology, faq, disclosures, status, plain
// 404), the handler short-circuits to env.ASSETS.fetch so the static
// HTML serves as-is. This keeps a single Worker route covering every
// path under /smoke-weather/<slug>.

import { recommend } from '../lib/affiliate/rules.js';
import { fetchForecastCached, nextEtMidnightMs } from '../lib/cache/weather.js';
import {
  jsonForScriptTag,
  renderAffiliateCardInner,
  renderDayCards,
  renderVerdictHeroInner,
  scoreAllDays,
  verdictHeroBandClass,
  pickBestDay,
} from '../lib/render/smokeWeather.js';
import { WeatherError } from '../lib/weather/errors.js';
import { type RouteContext } from '../router.js';
import type { Cooker, Cut } from '@shared/types';

const DEFAULT_CUT: Cut = 'brisket-packer';
const DEFAULT_COOKER: Cooker = 'offset';
const DEFAULT_DAYS = 7;

interface MetroRow {
  slug: string;
  name: string;
  state: string;
  zip: string;
  latitude: number;
  longitude: number;
}

export async function handleMetroPage(rc: RouteContext): Promise<Response> {
  const slug = rc.params.slug;
  if (!slug) return rc.env.ASSETS.fetch(rc.request);

  // Slug is reserved when it matches a known non-metro path under
  // /smoke-weather/. Pass those straight through to ASSETS instead of
  // hitting D1 — even a fast miss costs ~5 ms.
  if (RESERVED_SLUGS.has(slug)) {
    return rc.env.ASSETS.fetch(rc.request);
  }

  let metro: MetroRow | null;
  try {
    metro = await rc.env.SMOKE_DB.prepare(
      `SELECT slug, name, state, zip, latitude, longitude
         FROM metros WHERE slug = ?`
    )
      .bind(slug)
      .first<MetroRow>();
  } catch (err) {
    // D1 hiccup — don't break the page. Fall through to ASSETS; the
    // static template still works without SSR data (client JS will
    // populate the day cards from /api/forecast).
    console.warn('metroPage: D1 lookup failed', { slug, err: String(err) });
    return rc.env.ASSETS.fetch(rc.request);
  }
  if (!metro) {
    // Unknown slug under /smoke-weather/ — let ASSETS handle (it will
    // 404 if no static file matches).
    return rc.env.ASSETS.fetch(rc.request);
  }

  // Fetch the forecast. KV hit is the happy path; a miss triggers an
  // upstream call which may fail, in which case we render the static
  // template without SSR data and let the client fill it in.
  let forecast;
  try {
    forecast = await fetchForecastCached(
      rc.env.WEATHER_KV,
      metro.zip,
      metro.latitude,
      metro.longitude,
      DEFAULT_DAYS
    );
  } catch (err) {
    if (!(err instanceof WeatherError)) {
      console.warn('metroPage: forecast fetch failed', { slug, err: String(err) });
    }
    return rc.env.ASSETS.fetch(rc.request);
  }

  const scored = scoreAllDays(forecast.days, DEFAULT_CUT, DEFAULT_COOKER);
  if (scored.length === 0) {
    // Empty forecast — render the static shell.
    return rc.env.ASSETS.fetch(rc.request);
  }

  const heroClass = 'verdict-hero band-' + verdictHeroBandClass(scored);
  const heroInner = renderVerdictHeroInner({
    zip: metro.zip,
    locationName: `${metro.name}, ${metro.state}`,
    metro: metro.slug,
    source: forecast.source,
    days: scored,
  });
  const dayCardsHtml = renderDayCards(scored, {
    cut: DEFAULT_CUT,
    cooker: DEFAULT_COOKER,
    confidence: 'high',
  });
  const best = pickBestDay(scored);
  const rec = best ? recommend({ cut: DEFAULT_CUT, cooker: DEFAULT_COOKER, band: best.score.band }) : null;
  const affHtml = rec ? renderAffiliateCardInner(rec) : null;

  const ssrContext = jsonForScriptTag({
    cut: DEFAULT_CUT,
    cooker: DEFAULT_COOKER,
    zip: metro.zip,
    slug: metro.slug,
    source: forecast.source,
    generatedAt: new Date().toISOString(),
  });

  const upstream = await rc.env.ASSETS.fetch(rc.request);
  if (!upstream.ok || upstream.headers.get('content-type')?.indexOf('text/html') !== 0) {
    return upstream;
  }

  const rewriter = new HTMLRewriter()
    .on('section#verdictHero', {
      element(el) {
        el.setAttribute('class', heroClass);
        el.removeAttribute('hidden');
        el.setInnerContent(heroInner, { html: true });
      },
    })
    .on('div#dayCards', {
      element(el) {
        el.setInnerContent(dayCardsHtml, { html: true });
      },
    })
    .on('aside#affiliateSlot', {
      element(el) {
        if (!affHtml) return;
        el.setAttribute('class', 'affiliate-card');
        el.removeAttribute('hidden');
        el.setInnerContent(affHtml, { html: true });
      },
    })
    // Drop the SSR-context JSON island right before </main> so the
    // client can read it on init and skip the redundant initial
    // /api/forecast fetch when its saved cut/cooker matches.
    .on('main', {
      element(el) {
        el.append(
          '<script id="ssr-context" type="application/json">' +
            // Don't HTML-escape — JSON.stringify already escapes the
            // content, and the data has no `<` chars (zip/slug are
            // alphanumeric).
            ssrContext +
          '</script>',
          { html: true }
        );
      },
    });

  const transformed = rewriter.transform(upstream);
  const headers = new Headers(transformed.headers);
  // Cap the CDN cache at the next ET midnight rollover, when the new
  // day's KV data lands and the SSR'd forecast becomes stale. Without
  // the cap a fixed 12h s-maxage served at 23:59 ET would keep
  // yesterday's forecast live until ~11:59 the next day.
  const nowMs = Date.now();
  const sMaxAge = Math.max(60, Math.floor((nextEtMidnightMs(nowMs) - nowMs) / 1000));
  headers.set('Cache-Control', 'public, max-age=300, s-maxage=' + sMaxAge);
  // _headers does not apply to Worker-generated responses (CF docs). The
  // upstream asset fetch may or may not carry the inherited CSP, so set
  // frame-blocking only when no CSP is present — never strip a fuller
  // inherited policy. This forecast page is SEO content; block framing.
  if (!headers.has('Content-Security-Policy')) {
    headers.set('Content-Security-Policy', "frame-ancestors 'self'");
  }
  return new Response(transformed.body, {
    status: transformed.status,
    statusText: transformed.statusText,
    headers,
  });
}

// Known non-metro slugs under /smoke-weather/. Listed explicitly so a
// future hand-authored page can be added by name; an unknown slug
// triggers a D1 metros lookup (which is the right behavior for new
// city pages).
const RESERVED_SLUGS = new Set<string>([
  'methodology',
  'faq',
  'disclosures',
  'status',
  // `metros` is the chooser page (served by handleMetrosChooser at the
  // /smoke-weather/metros/ route). The no-trailing-slash form falls
  // through here and ASSETS handles the canonical-URL redirect.
  'metros',
]);
