// Shared secret-redaction helpers, used by both lib/cache/kv.ts (for
// cache telemetry summaries) and lib/sender/* (for error messages
// that may be persisted to D1 or surfaced via /api/status).
//
// The list is not exhaustive — defense-in-depth only. Callers must
// also avoid putting raw user payload into their own `error.message`
// strings in the first place.

export function redactSecrets(message: string): string {
  return (
    message
      // Email-shaped substrings: keep the domain visible, mask the local part.
      // This is the most common PII vector when error bodies echo user input.
      .replace(/\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi, '[redacted-email]@$1')
      // Provider-style key prefixes (Stripe sk_/pk_, OpenAI sk-, etc.).
      .replace(/\b(?:sk|pk)[_-][A-Za-z0-9_-]{8,}/g, '[redacted-key]')
      // GitHub PAT / fine-grained tokens.
      .replace(/\bghp_[A-Za-z0-9]{8,}/g, '[redacted-token]')
      // `Authorization: Bearer …` and the bare-keyword form.
      .replace(/\bAuthorization\s*:\s*\S+( \S+)?/gi, 'Authorization: [redacted]')
      .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
      // `token=…` / `api-key=…` / `secret=…` / `password=…` query-style.
      .replace(/\b(token|api[_-]?key|secret|password)\s*[=:]\s*\S+/gi, '$1=[redacted]')
  );
}

export function summarizeError(err: unknown): string {
  const name = err && typeof err === 'object' && 'name' in err ? String(err.name) : 'Error';
  const rawMessage =
    err && typeof err === 'object' && 'message' in err ? String(err.message) : '';
  const message = redactSecrets(rawMessage);
  return `${name}: ${message}`.replace(/\s+/g, ' ').trim().slice(0, 200);
}
