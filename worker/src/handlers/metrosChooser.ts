// GET /smoke-weather/metros/
//
// Server-side hydrates the 50-metro chooser page. The static template
// emits 50 tile anchors with skeleton text ("Score loading…", "Best
// day this week loading…") and a `band-pending` class. This handler:
//   1. Reads the day's metros aggregate from KV (`metros:v1:<et-date>`,
//      pre-warmed by the metrosPrewarm cron; previousEtDate fallback
//      for the first hour after midnight ET before the cron fires).
//   2. Fetches the static template from env.ASSETS.
//   3. Uses HTMLRewriter to rewrite each `.metro-tile` element's
//      inner content with the live score + best day, and swaps the
//      `band-pending` class for the matching `band-<x>`.
//   4. Drops a `<script id="metros-hydrated">` JSON island into <main>
//      so the client-side chooser script can skip its /api/metros
//      fetch (the DOM is already filled in).
//
// Cold-start path (KV miss on both today and yesterday): pass through
// the upstream response unchanged. The skeleton tiles render and the
// client script's /api/metros fetch repairs them.

import { aggregateKey, type MetroTileSummary, type MetrosSummary } from '../crons/metrosPrewarm.js';
import { etDayBucket, nextEtMidnightMs, previousEtDate } from '../lib/cache/weather.js';
import { escapeHtml, jsonForScriptTag } from '../lib/render/smokeWeather.js';
import { type RouteContext } from '../router.js';

// Quality labels for the chooser tiles. Kept byte-identical to the
// shared bandLabel in lib/render/smokeWeather.ts and the client copy in
// _partials/smoke-weather-app.js — only the human text is a quality
// word; the band keys + CSS color classes are unchanged.
function bandLabel(b: MetroTileSummary['todayBand']): string {
  if (b === 'ideal') return 'Ideal';
  if (b === 'green') return 'Good';
  if (b === 'yellow') return 'Average';
  return 'Poor';
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatShortDate(iso: string): string {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const parts = iso.split('-');
  const d = new Date(parseInt(parts[0]!, 10), parseInt(parts[1]!, 10) - 1, parseInt(parts[2]!, 10));
  return DAY_NAMES[d.getDay()]! + ' ' + MONTH_NAMES[d.getMonth()]! + ' ' + d.getDate();
}

export async function handleMetrosChooser(rc: RouteContext): Promise<Response> {
  const etDate = etDayBucket();
  // Track whether the data we're rendering is today's or yesterday's
  // fallback. The two states need different cache + hydration
  // semantics: today gets the full TTL + a hydrated marker; yesterday
  // gets a short TTL and NO marker so the client repairs itself via
  // /api/metros on the next visit (otherwise a CDN-cached fallback
  // page could outlive today's cron run, locking out fresh data).
  let summary: MetrosSummary | null = null;
  let isFallback = false;
  try {
    summary = await rc.env.WEATHER_KV.get<MetrosSummary>(aggregateKey(etDate), 'json');
    if (!summary) {
      const yesterday = previousEtDate(etDate);
      summary = await rc.env.WEATHER_KV.get<MetrosSummary>(aggregateKey(yesterday), 'json');
      isFallback = summary !== null;
    }
  } catch (err) {
    // KV availability blip — fall through to ASSETS and let the
    // client's /api/metros fetch repair the skeleton. Without this
    // try/catch the Worker would emit a 500 for an outage we can
    // gracefully degrade through.
    console.warn('metrosChooser: KV read failed', { err: String(err) });
    summary = null;
  }

  const upstream = await rc.env.ASSETS.fetch(rc.request);
  if (!upstream.ok || upstream.headers.get('content-type')?.indexOf('text/html') !== 0) {
    return upstream;
  }

  // Cold KV: serve the skeleton template unchanged. The client script
  // still calls /api/metros and fills in tiles when it lands.
  if (!summary || !Array.isArray(summary.metros) || summary.metros.length === 0) {
    return upstream;
  }

  const bySlug = new Map<string, MetroTileSummary>();
  for (const t of summary.metros) bySlug.set(t.slug, t);

  const rewriter = new HTMLRewriter()
    .on('a.metro-tile', {
      element(el) {
        const slug = el.getAttribute('data-slug');
        if (!slug) return;
        const tile = bySlug.get(slug);
        if (!tile) return;
        const name = el.getAttribute('data-name') ?? tile.name;
        const state = el.getAttribute('data-state') ?? tile.state;
        el.setAttribute('class', 'metro-tile band-' + tile.todayBand);
        // Rebuild the inner content from scratch — the skeleton text
        // was placeholder copy that the SSR must replace, and the
        // data-role hooks the client script needs are recreated.
        const bestLine = tile.bestDay
          ? 'Best: ' + escapeHtml(formatShortDate(tile.bestDay.date)) + ' &mdash; ' + tile.bestDay.score + '/100'
          : 'Best day this week unavailable';
        const inner =
          '<span class="metro-tile__name">' + escapeHtml(name) + ', ' + escapeHtml(state) + '</span>' +
          '<span class="metro-tile__score" data-role="today">' +
            '<strong>' + tile.todayScore + '/100</strong> &middot; ' + escapeHtml(bandLabel(tile.todayBand)) +
          '</span>' +
          '<span class="metro-tile__best" data-role="best">' + bestLine + '</span>';
        el.setInnerContent(inner, { html: true });
      },
    })
    // Drop the "hydrated" marker ONLY when serving today's data.
    // On the yesterday-fallback path we want the client to still call
    // /api/metros — the API endpoint may return today's data even
    // when our KV read missed (CDN edge ↔ KV propagation timing) and
    // a short-lived CDN entry for this fallback shouldn't outlive
    // the gap.
    .on('main', {
      element(el) {
        if (isFallback) return;
        el.append(
          '<script id="metros-hydrated" type="application/json">' +
            jsonForScriptTag({ etDate: summary!.etDate, generatedAt: summary!.generatedAt }) +
          '</script>',
          { html: true }
        );
      },
    });

  const transformed = rewriter.transform(upstream);
  const headers = new Headers(transformed.headers);
  // Cap CDN TTL at the next ET midnight rollover for the happy path,
  // and use a 60s ceiling on the yesterday-fallback path so a stale
  // version doesn't outlive today's cron landing.
  const nowMs = Date.now();
  const sMaxAge = isFallback
    ? 60
    : Math.max(60, Math.floor((nextEtMidnightMs(nowMs) - nowMs) / 1000));
  headers.set('Cache-Control', 'public, max-age=300, s-maxage=' + sMaxAge);
  // _headers does not apply to Worker-generated responses (CF docs). The
  // upstream asset fetch may or may not carry the inherited CSP, so set
  // frame-blocking only when no CSP is present — never strip a fuller
  // inherited policy. This chooser page is SEO content; block framing.
  if (!headers.has('Content-Security-Policy')) {
    headers.set('Content-Security-Policy', "frame-ancestors 'self'");
  }
  return new Response(transformed.body, {
    status: transformed.status,
    statusText: transformed.statusText,
    headers,
  });
}
