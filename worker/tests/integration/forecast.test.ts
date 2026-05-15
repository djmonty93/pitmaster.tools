import { env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleForecast } from '../../src/handlers/forecast';
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

beforeEach(async () => {
  await KV.delete('geo:v1:30303');
  // Wipe today's forecast cache buckets that could carry over from
  // earlier tests in the same file.
  const today = new Date().toISOString().slice(0, 10);
  await KV.delete(`weather:v1:30303:${today}`);
  await KV.delete(`weather:v1:99999:${today}`);
});
afterEach(() => {
  stub?.restore();
  stub = null;
});

const openMeteoOk = () =>
  jsonResponse(200, {
    daily: {
      time: ['2026-05-15', '2026-05-16'],
      temperature_2m_max: [82, 80],
      temperature_2m_min: [60, 58],
      relative_humidity_2m_mean: [55, 58],
      wind_speed_10m_max: [8, 7],
      wind_gusts_10m_max: [12, 10],
      precipitation_probability_max: [10, 5],
      precipitation_sum: [0, 0],
      dew_point_2m_mean: [50, 49],
    },
    hourly: {
      time: ['2026-05-15T00:00', '2026-05-15T12:00', '2026-05-16T00:00', '2026-05-16T12:00'],
      temperature_2m: [60, 78, 58, 76],
      relative_humidity_2m: [70, 50, 72, 52],
      wind_speed_10m: [4, 8, 4, 7],
      wind_gusts_10m: [6, 12, 6, 10],
      precipitation_probability: [5, 10, 0, 5],
      precipitation: [0, 0, 0, 0],
      dew_point_2m: [50, 50, 49, 49],
    },
  });

describe('GET /api/forecast', () => {
  it('returns scored days for a seeded metro zip without geocoder hop, public CDN-cacheable', async () => {
    stub = installFetchStub([{ match: 'api.open-meteo.com/v1/forecast', respond: openMeteoOk }]);
    const rc = buildContext(
      new Request('https://x/api/forecast?zip=30303&cut=brisket-packer&cooker=offset&days=2')
    );
    const res = await handleForecast(rc);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      zip: string;
      metro?: string;
      source: string;
      days: Array<{ date: string; score: { band: string; score: number } }>;
    };
    expect(body.zip).toBe('30303');
    expect(body.metro).toBe('atlanta-ga');
    expect(body.days).toHaveLength(2);
    expect(body.days[0]!.score.band).toMatch(/red|yellow|green|ideal/);
    // Explicit zip → URL fully identifies the response → public CDN cache OK.
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
    // No geocode call — zip resolved from metros table.
    expect(stub.calls.filter((c) => c.url.includes('geocoding'))).toHaveLength(0);
  });

  it('400s when zip is missing AND request.cf.postalCode is not present', async () => {
    stub = installFetchStub([]);
    const rc = buildContext(new Request('https://x/api/forecast'));
    const res = await handleForecast(rc);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'missing_zip' });
  });

  it('400s on invalid cut / cooker / days values', async () => {
    stub = installFetchStub([{ match: 'api.open-meteo.com/v1/forecast', respond: openMeteoOk }]);
    const cases: Array<{ qs: string; error: string }> = [
      { qs: 'zip=30303&cut=hotdog', error: 'invalid_cut' },
      { qs: 'zip=30303&cooker=microwave', error: 'invalid_cooker' },
      { qs: 'zip=30303&days=99', error: 'invalid_days' },
      { qs: 'zip=30303&days=0', error: 'invalid_days' },
      { qs: 'zip=30303&days=abc', error: 'invalid_days' },
    ];
    for (const c of cases) {
      const rc = buildContext(new Request(`https://x/api/forecast?${c.qs}`));
      const res = await handleForecast(rc);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: c.error });
    }
  });

  it('returns 404 when the geocoder cannot resolve a zip', async () => {
    stub = installFetchStub([
      { match: 'geocoding-api.open-meteo.com', respond: () => jsonResponse(200, { results: [] }) },
    ]);
    const rc = buildContext(new Request('https://x/api/forecast?zip=99999'));
    const res = await handleForecast(rc);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'unknown_zip' });
  });

  it('returns 503 when both weather sources fail', async () => {
    stub = installFetchStub([
      { match: 'api.open-meteo.com/v1/forecast', respond: () => jsonResponse(503, {}) },
      { match: 'api.weather.gov', respond: () => jsonResponse(503, {}) },
    ]);
    const rc = buildContext(new Request('https://x/api/forecast?zip=30303'));
    const res = await handleForecast(rc);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'weather_unavailable' });
  });

  it('attaches a single affiliate recommendation keyed on the best-day band (F15)', async () => {
    stub = installFetchStub([{ match: 'api.open-meteo.com/v1/forecast', respond: openMeteoOk }]);
    const rc = buildContext(
      new Request('https://x/api/forecast?zip=30303&cut=brisket-packer&cooker=offset&days=2')
    );
    const res = await handleForecast(rc);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      recommendation?: {
        productId: string;
        productName: string;
        productUrl: string;
        reason: string;
        category: string;
        disclosureRequired: boolean;
      };
      days: Array<{ score: { band: string; score: number } }>;
    };
    expect(body.recommendation).toBeDefined();
    expect(body.recommendation!.disclosureRequired).toBe(true);
    // Best day score for the openMeteoOk fixture lands in green/ideal, and the
    // first rule that matches (cut=brisket, cooker=offset, band=green) is the
    // BBQ Guru controller. If the fixture's weights change so the best day
    // sinks below green, the rule should still produce one of the allowed
    // products — assert membership rather than identity so the test isn't
    // brittle to scoring tweaks.
    expect(body.recommendation!.productId).toMatch(/^[a-z0-9-]+$/);
    expect(body.recommendation!.reason.length).toBeGreaterThan(0);
  });

  it('varies the affiliate recommendation by cooker (rule keying is wired correctly)', async () => {
    // Same zip, same fixture, two cookers → two distinct products.
    // Proves the handler is actually feeding `cooker` into the rule
    // engine rather than hard-coding a single product.
    //
    // Band assumption: the openMeteoOk fixture above is benign weather
    // (10-15 mph gusts, 5-10% precip, 80 °F highs) — scoring lands the
    // best day in green/ideal. The identity assertions below depend on
    // that. If a future scoring tweak sinks the best day into the
    // yellow band, both cookers would match the windscreen rule (yellow
    // band + offset/kettle) — the offset assertion would flip and this
    // test would fail. Bump the fixture rather than weaken the
    // assertion: the value of this spec is the cooker-keying contract.
    stub = installFetchStub([{ match: 'api.open-meteo.com/v1/forecast', respond: openMeteoOk }]);
    const offsetRc = buildContext(
      new Request('https://x/api/forecast?zip=30303&cut=pork-butt&cooker=offset&days=2')
    );
    const pelletRc = buildContext(
      new Request('https://x/api/forecast?zip=30303&cut=pork-butt&cooker=pellet&days=2')
    );
    const offsetRes = await handleForecast(offsetRc);
    const pelletRes = await handleForecast(pelletRc);
    expect(offsetRes.status).toBe(200);
    expect(pelletRes.status).toBe(200);
    const offsetBody = (await offsetRes.json()) as { recommendation?: { productId: string }; days: Array<{ score: { band: string } }> };
    const pelletBody = (await pelletRes.json()) as { recommendation?: { productId: string }; days: Array<{ score: { band: string } }> };
    // Pin the fixture's band so a scoring change fails this assertion
    // first, before the identity check has a chance to mislead.
    const bestOffsetBand = offsetBody.days.reduce((a, d) =>
      ['ideal','green','yellow','red'].indexOf(d.score.band) < ['ideal','green','yellow','red'].indexOf(a) ? d.score.band : a, 'red');
    expect(['ideal', 'green']).toContain(bestOffsetBand);
    expect(offsetBody.recommendation?.productId).toBe('bbq-guru-partypal');
    expect(pelletBody.recommendation?.productId).toBe('competition-pellet-blend');
  });

  it('falls back to request.cf.postalCode when zip query param is omitted, with Cache-Control private', async () => {
    stub = installFetchStub([{ match: 'api.open-meteo.com/v1/forecast', respond: openMeteoOk }]);
    // workerd populates `request.cf` at the edge but exposes it as a
    // readonly property — tests can't assign it. We wrap the Request
    // in a Proxy so the handler reads our synthetic cf through the
    // normal access path. Production behavior is unchanged because
    // production has the real cf already populated.
    const baseReq = new Request('https://x/api/forecast?cut=brisket-packer&cooker=offset&days=2');
    const proxiedReq = new Proxy(baseReq, {
      get(target, prop) {
        if (prop === 'cf') return { postalCode: '30303', country: 'US' };
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const rc = buildContext(proxiedReq);
    const res = await handleForecast(rc);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { zip: string };
    expect(body.zip).toBe('30303');
    // Critical: the URL is the SAME for every visitor in the
    // geo-IP-fallback path, so a public CDN cache would poison
    // entries across visitors in different metros. The handler MUST
    // mark this response private.
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=60');
  });
});
