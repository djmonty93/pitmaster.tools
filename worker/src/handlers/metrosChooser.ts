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
import { etDayBucket, previousEtDate } from '../lib/cache/weather.js';
import { escapeHtml } from '../lib/render/smokeWeather.js';
import { type RouteContext } from '../router.js';

function bandLabel(b: MetroTileSummary['todayBand']): string {
  if (b === 'ideal') return 'Ideal';
  if (b === 'green') return 'Green';
  if (b === 'yellow') return 'Yellow';
  return 'Red';
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
  let summary = await rc.env.WEATHER_KV.get<MetrosSummary>(aggregateKey(etDate), 'json');
  if (!summary) {
    const yesterday = previousEtDate(etDate);
    summary = await rc.env.WEATHER_KV.get<MetrosSummary>(aggregateKey(yesterday), 'json');
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
    // A small JSON island tells the client script the page is already
    // hydrated, so it can skip its /api/metros fetch. The filter
    // input still works the same regardless.
    .on('main', {
      element(el) {
        el.append(
          '<script id="metros-hydrated" type="application/json">' +
            JSON.stringify({ etDate: summary!.etDate, generatedAt: summary!.generatedAt }) +
          '</script>',
          { html: true }
        );
      },
    });

  const transformed = rewriter.transform(upstream);
  const headers = new Headers(transformed.headers);
  headers.set('Cache-Control', 'public, max-age=300, s-maxage=43200');
  return new Response(transformed.body, {
    status: transformed.status,
    statusText: transformed.statusText,
    headers,
  });
}
