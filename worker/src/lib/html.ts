// Shared HTML-rendering primitives for the Worker runtime.
//
// These three helpers were duplicated across the SSR render layer
// (lib/render/smokeWeather.ts), the articles handler, and the weekly
// article cron. They are behaviorally identical, so they live here as
// the single worker-side source. lib/render/smokeWeather.ts re-exports
// escapeHtml/fmtNum/jsonForScriptTag so its existing importers
// (metrosChooser.ts, metroPage.ts, digestEmail.ts) stay untouched.

const HTML_ESCAPE_RE = /[&<>"']/g;
const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

export function escapeHtml(s: string): string {
  return String(s).replace(HTML_ESCAPE_RE, (c) => HTML_ESCAPE_MAP[c]!);
}

/**
 * Serialize a value as JSON safe for embedding inside an inline
 * `<script type="application/json">` tag. `JSON.stringify` alone does
 * not escape `</script>` (since `/` and `<` are valid JSON chars),
 * which means a future field carrying that substring would close the
 * outer script element and create an XSS surface. Replace the `<`
 * with its Unicode escape — semantically identical JSON, but no
 * possibility of confusing the HTML parser.
 */
export function jsonForScriptTag(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

// Mirrors fmtNum() in _partials/smoke-weather-app.js: render as rounded
// integer, or em dash when the value is null/undefined/NaN.
export function fmtNum(v: number | null | undefined): string {
  return Number.isFinite(v as number) ? String(Math.round(v as number)) : '—';
}
