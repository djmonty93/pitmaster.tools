// HMAC-SHA256 auth tokens for subscriber-scoped endpoints.
//
// Problem we're solving: /api/unsubscribe and /api/preferences (GET +
// PATCH) need to prove the caller owns the email they're acting on.
// Without that proof anyone can mass-unsubscribe arbitrary emails,
// enumerate subscriber preferences, or vandalize cut/cooker choices.
//
// Approach: when /api/subscribe succeeds we return a token computed
// as `HMAC-SHA256(lowercased-email, secret).hex`. Subsequent
// subscriber-scoped calls must include this token. Tokens never
// expire (the secret can be rotated to invalidate), which matches
// the lifecycle of a newsletter-style relationship.
//
// `verifyToken` uses a constant-time compare so we don't leak the
// expected token via timing differences.

const enc = new TextEncoder();

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

export async function signToken(email: string, secret: string): Promise<string> {
  if (!secret || /\s/.test(secret)) {
    throw new TypeError('signToken: secret must be a non-empty no-whitespace string');
  }
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(email.trim().toLowerCase()));
  return toHex(new Uint8Array(sig));
}

/**
 * Returns true iff `token` matches `signToken(email, secret)` using a
 * constant-time comparison. Returns false on any malformed input
 * rather than throwing — callers branch on the boolean.
 */
export async function verifyToken(email: string, token: string, secret: string): Promise<boolean> {
  if (typeof email !== 'string' || typeof token !== 'string' || !secret) return false;
  if (token.length !== 64) return false; // 32 bytes → 64 hex chars
  const expected = await signToken(email, secret);
  return constantTimeEqual(expected, token);
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, '0');
  return out;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
