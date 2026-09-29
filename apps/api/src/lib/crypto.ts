import { createHash, randomBytes } from 'node:crypto';

// Opaque tokens (refresh, invite, password reset) are random; the DB only ever
// stores their SHA-256, so a leaked table cannot be replayed.
export function generateOpaqueToken(bytes = 48): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
