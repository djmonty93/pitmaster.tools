import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  aggregateKey,
  runMetrosPrewarm,
  type MetrosSummary,
} from '../../../src/crons/metrosPrewarm';
import type { Env } from '../../../src/index';
import { etDayBucket } from '../../../src/lib/cache/weather';
import { applyMigrations } from '../../helpers/d1';
import { installFetchStub, jsonResponse, type FetchStub } from '../../helpers/fetchStub';

interface E {
  SMOKE_DB: D1Database;
  WEATHER_KV: KVNamespace;
}
const DB = (env as unknown as E).SMOKE_DB;
const KV = (env as unknown as E).WEATHER_KV;

beforeAll(async () => {
  await applyMigrations(DB);
});

let stub: FetchStub | null = null;

beforeEach(async () => {
  // Wipe the aggregate + any per-metro cache rows from a previous run
  // so each test starts with a clean cache.
  const today = etDayBucket();
  await KV.delete(aggregateKey(today));
  stub?.restore();
  stub = null;
});

function buildEnv(): Env {
  return {
    ASSETS: undefined as unknown as Fetcher,
    WEATHER_KV: KV,
    SMOKE_DB: DB,
    SENDER_API_TOKEN: 'sender_test_token',
    SUBSCRIBER_TOKEN_SECRET: 'test-secret-32-bytes-long-aaaaaaaaa',
  };
}

const openMeteoSeven = () =>
  jsonResponse(200, {
    daily: {
      time: [
        '2026-05-15', '2026-05-16', '2026-05-17',
        '2026-05-18', '2026-05-19', '2026-05-20', '2026-05-21',
      ],
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
      time: ['2026-05-15T00:00', '2026-05-15T12:00'],
      temperature_2m: [60, 78],
      relative_humidity_2m: [70, 50],
      wind_speed_10m: [4, 8],
      wind_gusts_10m: [6, 12],
      precipitation_probability: [5, 10],
      precipitation: [0, 0],
      dew_point_2m: [50, 50],
    },
  });

describe('runMetrosPrewarm', () => {
  it('writes a metros:v1:<et-date> aggregate covering every D1 metro on the happy path', async () => {
    stub = installFetchStub([
      { match: 'api.open-meteo.com/v1/forecast', respond: openMeteoSeven },
    ]);
    const e = buildEnv();
    // Distinct scheduledTime per test so each gets a fresh per-metro
    // cache slot (etDayBucket differs by day). Without this, cached
    // entries from earlier tests in the run mask the failure-injection
    // we set up below.
    const summary = await runMetrosPrewarm(e, new Date('2026-05-15T05:00:00Z'));

    // D1 fixture seeds all 50 metros; aggregate should cover every one.
    expect(summary.metros.length).toBeGreaterThanOrEqual(50);
    expect(summary.etDate).toBe(etDayBucket(Date.UTC(2026, 4, 15, 5, 0)));
    expect(summary.defaultCut).toBe('brisket-packer');
    expect(summary.defaultCooker).toBe('offset');

    // Each tile carries today's score + a best-day pointer.
    for (const tile of summary.metros) {
      expect(tile.slug).toMatch(/^[a-z0-9-]+$/);
      expect(tile.todayScore).toBeGreaterThanOrEqual(0);
      expect(tile.todayScore).toBeLessThanOrEqual(100);
      expect(tile.todayBand).toMatch(/red|yellow|green|ideal/);
      expect(tile.bestDay.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(tile.bestDay.score).toBeGreaterThanOrEqual(tile.todayScore);
    }

    // Aggregate is readable via the same key the /api/metros handler
    // uses — that's the only contract the chooser depends on.
    const fromKv = await KV.get<MetrosSummary>(aggregateKey(summary.etDate), 'json');
    expect(fromKv).not.toBeNull();
    expect(fromKv!.metros.length).toBe(summary.metros.length);
  });

  it('skips a metro on geocoder failure without aborting the rest', async () => {
    // The D1 fast-path covers every seeded zip, so the cron never hits
    // the geocoder for them. To exercise the partial-failure branch we
    // make Open-Meteo's forecast endpoint fail for ONE specific lat/lon
    // pair (Atlanta) and succeed for everyone else. The cron's
    // try/catch turns that into a logged skip.
    stub = installFetchStub([
      {
        match: 'api.open-meteo.com/v1/forecast',
        respond: (rawUrl) => {
          const u = new URL(rawUrl);
          // Atlanta seeded zip 30303 → latitude 33.7525 in D1 metros.
          if (u.searchParams.get('latitude')?.startsWith('33.75')) {
            return jsonResponse(503, {});
          }
          return openMeteoSeven();
        },
      },
      // NWS failover (the adapter falls back here on Open-Meteo failure)
      // must also fail for the same metro, otherwise the cron silently
      // recovers via NWS and the tile still lands in the aggregate.
      {
        match: 'api.weather.gov',
        respond: (rawUrl) => {
          if (rawUrl.includes('/33.75')) {
            return jsonResponse(503, {});
          }
          return jsonResponse(503, {});
        },
      },
    ]);
    const e = buildEnv();
    // Use a different ET day from the happy-path test so per-metro
    // cache rows (weather:v2:<zip>:<et-date>) don't carry over and
    // bypass the failure injection on the failing latitude.
    const summary = await runMetrosPrewarm(e, new Date('2026-05-16T05:00:00Z'));

    // Atlanta is missing; the other 49 still made it in.
    const slugs = summary.metros.map((m) => m.slug);
    expect(slugs).not.toContain('atlanta-ga');
    expect(summary.metros.length).toBeGreaterThanOrEqual(49);
  });
});
