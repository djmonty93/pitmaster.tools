// Tiny router for the Best Smoke Days worker. Pattern-matches
// method + path against a route table, captures `:slug`-style params,
// and falls through to ASSETS for anything unmatched.
//
// We don't pull in itty-router or hono because every kB of worker
// bundle costs us against the 10 MB limit (worker also carries
// @sentry/cloudflare in Step 17), and the match logic we need fits in
// 30 lines. Each handler receives a typed `Context` object so it can
// reach env bindings + URL search params without re-parsing.

import type { Env } from './index.js';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RouteContext {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  url: URL;
  /** Path params captured from `:name` segments. */
  params: Record<string, string>;
}

export type Handler = (ctx: RouteContext) => Promise<Response> | Response;

export interface Route {
  method: Method;
  /** Pattern with `:slug`-style params, e.g. `/articles/:slug`. */
  pattern: string;
  handler: Handler;
}

interface CompiledRoute extends Route {
  regex: RegExp;
  paramNames: string[];
}

export function compileRoutes(routes: Route[]): CompiledRoute[] {
  return routes.map((r) => {
    const paramNames: string[] = [];
    const regexSource = r.pattern
      .replace(/[.+*?()|[\]\\]/g, '\\$&')
      .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_m, name) => {
        paramNames.push(name);
        return '([^/]+)';
      });
    return { ...r, regex: new RegExp(`^${regexSource}$`), paramNames };
  });
}

/**
 * Match request against `routes`. Returns the matched route's response
 * or `null` if no route matched (caller decides — usually falls through
 * to env.ASSETS.fetch). 405 is the responsibility of this router only
 * if a different method matches the same path; otherwise we treat it
 * as "no match" so static assets get a clean fall-through.
 */
export async function dispatch(
  routes: CompiledRoute[],
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response | null> {
  const url = new URL(request.url);
  const method = request.method as Method;
  let methodMismatchOnly = false;
  for (const route of routes) {
    const m = route.regex.exec(url.pathname);
    if (!m) continue;
    if (route.method !== method) {
      methodMismatchOnly = true;
      continue;
    }
    const params: Record<string, string> = {};
    for (let i = 0; i < route.paramNames.length; i++) {
      params[route.paramNames[i]!] = decodeURIComponent(m[i + 1]!);
    }
    return await route.handler({ request, env, ctx, url, params });
  }
  if (methodMismatchOnly) {
    return jsonError(405, 'method_not_allowed', 'Method not allowed for this path');
  }
  return null;
}

// ── Response helpers ─────────────────────────────────────────────────

export interface ApiErrorBody {
  error: string;
  message: string;
  /** Optional extra fields for callers (e.g. validation issue paths). */
  details?: unknown;
}

const SECURITY_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

export function json<T>(status: number, body: T, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...SECURITY_HEADERS,
      ...extraHeaders,
    },
  });
}

export function jsonError(
  status: number,
  code: string,
  message: string,
  details?: unknown
): Response {
  const body: ApiErrorBody = { error: code, message };
  if (details !== undefined) body.details = details;
  return json(status, body);
}

export function html(status: number, body: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      ...SECURITY_HEADERS,
      ...extraHeaders,
    },
  });
}
