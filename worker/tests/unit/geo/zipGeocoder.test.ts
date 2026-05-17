import { env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GeocoderError, resolveZip } from '../../../src/lib/geo/zipGeocoder';
import { applyMigrations } from '../../helpers/d1';
import { installFetchStub, jsonResponse, type FetchStub } from '../../helpers/fetchStub';

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
  await KV.delete('geo:v3:30303');
  await KV.delete('geo:v3:99999');
});
afterEach(() => {
  stub?.restore();
  stub = null;
});

describe('resolveZip', () => {
  it('rejects an obviously bad zip without touching D1 or fetch', async () => {
    stub = installFetchStub([]);
    await expect(resolveZip(KV, DB, 'abcd')).rejects.toMatchObject({
      name: 'GeocoderError',
      kind: 'invalid_zip',
    });
    expect(stub.calls).toHaveLength(0);
  });

  it('fast-paths a zip that exists in the seeded metros table', async () => {
    stub = installFetchStub([]);
    // 30303 is Atlanta, GA per migration 0002_metros_seed.sql.
    const loc = await resolveZip(KV, DB, '30303');
    expect(loc.metroSlug).toBe('atlanta-ga');
    expect(loc.timezone).toBe('America/New_York');
    expect(loc.state).toBe('GA');
    // No fetch call — fast path.
    expect(stub.calls).toHaveLength(0);
  });

  it('falls through to the geocoding API for a zip outside the seeded metros', async () => {
    stub = installFetchStub([
      {
        match: 'geocoding-api.open-meteo.com',
        respond: () =>
          jsonResponse(200, {
            results: [
              {
                latitude: 35.5,
                longitude: -119.0,
                timezone: 'America/Los_Angeles',
                name: 'Bakersfield',
                admin1: 'California',
                country_code: 'US',
                postcodes: ['99999'],
              },
            ],
          }),
      },
    ]);
    const loc = await resolveZip(KV, DB, '99999');
    expect(loc.latitude).toBe(35.5);
    expect(loc.timezone).toBe('America/Los_Angeles');
    expect(loc.metroSlug).toBeNull();
    // admin1 "California" → "CA" via the state-name→code map.
    expect(loc.state).toBe('CA');
    expect(stub.calls).toHaveLength(1);
    // Verify the upstream query uses Open-Meteo's `name` param, not the
    // unsupported `postal_code` that returned HTTP 400 before this fix.
    const requestedUrl = String(stub.calls[0]?.url ?? '');
    expect(requestedUrl).toContain('name=99999');
    expect(requestedUrl).not.toContain('postal_code=');
  });

  it('prefers a result whose postcodes array contains the requested zip', async () => {
    stub = installFetchStub([
      {
        match: 'geocoding-api.open-meteo.com',
        respond: () =>
          jsonResponse(200, {
            results: [
              {
                latitude: 1,
                longitude: 1,
                timezone: 'America/New_York',
                name: 'Wrong Match',
                admin1: 'New York',
                country_code: 'US',
                postcodes: ['11111'],
              },
              {
                latitude: 35.5,
                longitude: -119.0,
                timezone: 'America/Los_Angeles',
                name: 'Bakersfield',
                admin1: 'California',
                country_code: 'US',
                postcodes: ['99999'],
              },
            ],
          }),
      },
    ]);
    const loc = await resolveZip(KV, DB, '99999');
    expect(loc.name).toBe('Bakersfield, California');
    expect(loc.state).toBe('CA');
  });

  it('rejects a multi-result response where none echo the requested zip', async () => {
    stub = installFetchStub([
      {
        match: 'geocoding-api.open-meteo.com',
        respond: () =>
          jsonResponse(200, {
            results: [
              {
                latitude: 1,
                longitude: 1,
                timezone: 'America/New_York',
                name: 'Fuzzy A',
                admin1: 'New York',
                country_code: 'US',
                postcodes: ['11111'],
              },
              {
                latitude: 2,
                longitude: 2,
                timezone: 'America/New_York',
                name: 'Fuzzy B',
                admin1: 'New York',
                country_code: 'US',
                postcodes: ['22222'],
              },
            ],
          }),
      },
    ]);
    await expect(resolveZip(KV, DB, '99999')).rejects.toMatchObject({
      name: 'GeocoderError',
      kind: 'not_found',
    });
  });

  it('returns state=null when admin1 is missing or unrecognized', async () => {
    stub = installFetchStub([
      {
        match: 'geocoding-api.open-meteo.com',
        respond: () =>
          jsonResponse(200, {
            results: [
              {
                latitude: 0,
                longitude: 0,
                timezone: 'UTC',
                name: 'Unknown',
                postcodes: ['99999'],
                // No admin1
              },
            ],
          }),
      },
    ]);
    const loc = await resolveZip(KV, DB, '99999');
    expect(loc.state).toBeNull();
  });

  it('caches the geocode result so a second call skips the network', async () => {
    stub = installFetchStub([
      {
        match: 'geocoding-api.open-meteo.com',
        respond: () =>
          jsonResponse(200, {
            results: [
              {
                latitude: 35.5,
                longitude: -119.0,
                timezone: 'America/Los_Angeles',
                name: 'Bakersfield',
                admin1: 'California',
                country_code: 'US',
                postcodes: ['99999'],
              },
            ],
          }),
      },
    ]);
    await resolveZip(KV, DB, '99999');
    await resolveZip(KV, DB, '99999');
    expect(stub.calls).toHaveLength(1);
  });

  it('maps a no-results geocoder response to GeocoderError(kind=not_found)', async () => {
    stub = installFetchStub([
      {
        match: 'geocoding-api.open-meteo.com',
        respond: () => jsonResponse(200, { results: [] }),
      },
    ]);
    await expect(resolveZip(KV, DB, '99999')).rejects.toMatchObject({
      name: 'GeocoderError',
      kind: 'not_found',
    });
  });

  it('surfaces upstream HTTP failures', async () => {
    stub = installFetchStub([
      { match: 'geocoding-api.open-meteo.com', respond: () => jsonResponse(503, {}) },
    ]);
    await expect(resolveZip(KV, DB, '99999')).rejects.toMatchObject({
      name: 'GeocoderError',
      kind: 'http',
      status: 503,
    });
  });
});
