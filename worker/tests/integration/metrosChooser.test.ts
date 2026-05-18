import { env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  aggregateKey,
  type MetrosSummary,
} from '../../src/crons/metrosPrewarm';
import { handleMetrosChooser } from '../../src/handlers/metrosChooser';
import { etDayBucket, previousEtDate } from '../../src/lib/cache/weather';
import { applyMigrations } from '../helpers/d1';
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

// Minimal chooser template with the two anchors handleMetrosChooser
// targets: a.metro-tile elements (with the data-* hooks the build
// script emits in real life) and a <main> for the JSON island.
const CHOOSER_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>Browse 50 metros</title></head>
<body>
<main>
  <a class="metro-tile band-pending" href="/smoke-weather/atlanta-ga" data-slug="atlanta-ga" data-name="Atlanta" data-state="GA"><span class="metro-tile__name">Atlanta, GA</span><span class="metro-tile__score" data-role="today">Score loading…</span><span class="metro-tile__best" data-role="best">Best day this week loading…</span></a>
  <a class="metro-tile band-pending" href="/smoke-weather/new-york-ny" data-slug="new-york-ny" data-name="New York" data-state="NY"><span class="metro-tile__name">New York, NY</span><span class="metro-tile__score" data-role="today">Score loading…</span><span class="metro-tile__best" data-role="best">Best day this week loading…</span></a>
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
  const today = etDayBucket();
  await KV.delete(aggregateKey(today));
  await KV.delete(aggregateKey(previousEtDate(today)));
});

const SAMPLE_SUMMARY: MetrosSummary = {
  generatedAt: '2026-05-18T05:00:00Z',
  etDate: etDayBucket(),
  defaultCut: 'brisket-packer',
  defaultCooker: 'offset',
  metros: [
    {
      slug: 'atlanta-ga', name: 'Atlanta', state: 'GA', zip: '30303',
      todayScore: 68, todayBand: 'yellow',
      bestDay: { date: '2026-05-22', score: 88, band: 'ideal' },
    },
    {
      slug: 'new-york-ny', name: 'New York', state: 'NY', zip: '10001',
      todayScore: 84, todayBand: 'green',
      bestDay: { date: '2026-05-20', score: 91, band: 'ideal' },
    },
  ],
};

describe('handleMetrosChooser', () => {
  it('hydrates every tile with live score + best day from KV', async () => {
    await KV.put(aggregateKey(SAMPLE_SUMMARY.etDate), JSON.stringify(SAMPLE_SUMMARY));
    const rc = buildContext(
      new Request('https://x/smoke-weather/metros/'),
      {},
      { ASSETS: makeAssets(CHOOSER_HTML) }
    );
    const res = await handleMetrosChooser(rc);
    expect(res.status).toBe(200);
    const body = await res.text();

    // band-pending swapped for live band classes.
    expect(body).not.toMatch(/band-pending/);
    expect(body).toMatch(/class="metro-tile band-yellow"[^>]*data-slug="atlanta-ga"/);
    expect(body).toMatch(/class="metro-tile band-green"[^>]*data-slug="new-york-ny"/);

    // Tile inner content includes the score and the proper-case band.
    expect(body).toMatch(/<strong>68\/100<\/strong> &middot; Yellow/);
    expect(body).toMatch(/<strong>84\/100<\/strong> &middot; Green/);
    expect(body).toMatch(/Best: .+ &mdash; 88\/100/);
    expect(body).toMatch(/Best: .+ &mdash; 91\/100/);

    // JSON island appended to <main> so the client skips the redundant
    // /api/metros fetch.
    expect(body).toMatch(/<script id="metros-hydrated" type="application\/json">/);
    expect(res.headers.get('Cache-Control')).toMatch(/public.*s-maxage=\d+/);
  });

  it('falls back to yesterday aggregate when today is missing — without the hydrated marker', async () => {
    const yesterday = previousEtDate(SAMPLE_SUMMARY.etDate);
    await KV.put(aggregateKey(yesterday), JSON.stringify({ ...SAMPLE_SUMMARY, etDate: yesterday }));
    const rc = buildContext(
      new Request('https://x/smoke-weather/metros/'),
      {},
      { ASSETS: makeAssets(CHOOSER_HTML) }
    );
    const res = await handleMetrosChooser(rc);
    const body = await res.text();
    // Yesterday's data still hydrates the tiles so the page shows
    // real numbers instead of skeletons.
    expect(body).toMatch(/<strong>68\/100<\/strong>/);
    // But the `metros-hydrated` marker is omitted so the client
    // script still calls /api/metros — the API endpoint may have
    // today's data even when our KV read missed (eventual-consistency
    // gap), and the client repair is the safety net.
    expect(body).not.toMatch(/metros-hydrated/);
    // Short Cache-Control so the fallback doesn't outlive today's
    // cron landing.
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300, s-maxage=60');
  });

  it('passes the template through unchanged when KV is cold', async () => {
    const rc = buildContext(
      new Request('https://x/smoke-weather/metros/'),
      {},
      { ASSETS: makeAssets(CHOOSER_HTML) }
    );
    const res = await handleMetrosChooser(rc);
    const body = await res.text();
    // Skeleton classes remain; the client script's /api/metros fetch
    // is the fallback path.
    expect(body).toMatch(/class="metro-tile band-pending"/);
    expect(body).toMatch(/Score loading…/);
    expect(body).not.toMatch(/metros-hydrated/);
  });
});
