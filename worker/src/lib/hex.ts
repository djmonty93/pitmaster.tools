// Lowercase hex encoding for byte arrays (e.g. SHA-256 / HMAC digests).
// Shared so the HMAC token signer (lib/auth/token.ts) and the pin-image
// content-addresser (handlers/pinImage.ts) can't drift apart.

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, '0');
  return out;
}
