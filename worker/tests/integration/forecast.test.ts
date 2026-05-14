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
