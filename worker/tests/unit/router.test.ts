import { describe, expect, it } from 'vitest';
import { compileRoutes, dispatch, json, jsonError, type Handler } from '../../src/router';
import type { Env } from '../../src/index';

const fakeEnv = {} as Env;
const fakeCtx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;

const okHandler: Handler = () => json(200, { ok: true });

describe('router', () => {
  it('matches a literal path + method', async () => {
    const routes = compileRoutes([{ method: 'GET', pattern: '/api/health', handler: okHandler }]);
    const res = await dispatch(routes, new Request('https://x/api/health'), fakeEnv, fakeCtx);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
  });

  it('returns null when no route matches at all', async () => {
    const routes = compileRoutes([{ method: 'GET', pattern: '/api/health', handler: okHandler }]);
    const res = await dispatch(routes, new Request('https://x/index.html'), fakeEnv, fakeCtx);
    expect(res).toBeNull();
  });

  it('returns 405 when path matches but method does not', async () => {
    const routes = compileRoutes([{ method: 'POST', pattern: '/api/subscribe', handler: okHandler }]);
    const res = await dispatch(
      routes,
      new Request('https://x/api/subscribe', { method: 'GET' }),
      fakeEnv,
      fakeCtx
    );
    expect(res!.status).toBe(405);
    expect(await res!.json()).toMatchObject({ error: 'method_not_allowed' });
  });

  it('captures :slug params and url-decodes them', async () => {
    let seenSlug = '';
    const routes = compileRoutes([
      {
        method: 'GET',
        pattern: '/articles/:slug',
        handler: (rc) => {
          seenSlug = rc.params['slug']!;
          return json(200, {});
        },
      },
    ]);
    const res = await dispatch(
      routes,
      new Request('https://x/articles/my-article%20name'),
      fakeEnv,
      fakeCtx
    );
    expect(res!.status).toBe(200);
    expect(seenSlug).toBe('my-article name');
  });

  it('does not let :slug span path segments', async () => {
    let seenSlug = '';
    const routes = compileRoutes([
      {
        method: 'GET',
        pattern: '/articles/:slug',
        handler: (rc) => {
          seenSlug = rc.params['slug'] ?? '<none>';
          return json(200, {});
        },
      },
    ]);
    const res = await dispatch(
      routes,
      new Request('https://x/articles/foo/bar'),
      fakeEnv,
      fakeCtx
    );
    expect(res).toBeNull(); // didn't match (slug regex excludes '/')
    expect(seenSlug).toBe('');
  });

  it('jsonError carries the right shape and security headers', () => {
    const res = jsonError(400, 'bad', 'nope', { field: 'x' });
    expect(res.status).toBe(400);
    expect(res.headers.get('Content-Type')).toMatch(/^application\/json/);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('json helper merges extra headers and lets them override defaults', () => {
    const res = json(200, { ok: true }, { 'Cache-Control': 'public, max-age=60' });
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
  });
});
