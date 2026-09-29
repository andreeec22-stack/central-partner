import jwt from 'jsonwebtoken';
import { generateOpaqueToken, sha256 } from '../../src/lib/crypto';
import { hashPassword, verifyPassword } from '../../src/lib/password';
import { signAccessToken, verifyAccessToken } from '../../src/lib/tokens';
import { passwordSchema, registerSchema } from '../../src/modules/auth/auth.schemas';

const claims = { sub: 'u-1', wid: 'w-1', sid: 's-1', role: 'ADMIN' as const };

describe('password hashing', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse');
    expect(hash).not.toContain('correct horse');
    await expect(verifyPassword('correct horse', hash)).resolves.toBe(true);
    await expect(verifyPassword('wrong horse', hash)).resolves.toBe(false);
  });
});

describe('access tokens', () => {
  it('round-trips claims', () => {
    expect(verifyAccessToken(signAccessToken(claims))).toEqual(claims);
  });

  it('rejects a token signed with another secret', () => {
    const forged = jwt.sign(claims, 'another-secret-that-is-also-long-enough!!', {
      issuer: 'central-partner',
      audience: 'central-partner-api',
    });
    expect(verifyAccessToken(forged)).toBeNull();
  });

  it('rejects an expired token', () => {
    const expired = jwt.sign({ ...claims, exp: Math.floor(Date.now() / 1000) - 10 }, process.env.JWT_SECRET!, {
      issuer: 'central-partner',
      audience: 'central-partner-api',
    });
    expect(verifyAccessToken(expired)).toBeNull();
  });

  it('rejects the "none" algorithm', () => {
    const unsigned = jwt.sign(claims, '', { algorithm: 'none', issuer: 'central-partner', audience: 'central-partner-api' });
    expect(verifyAccessToken(unsigned)).toBeNull();
  });
});

describe('opaque tokens', () => {
  it('are unique and hash deterministically', () => {
    const a = generateOpaqueToken();
    const b = generateOpaqueToken();
    expect(a).not.toBe(b);
    expect(sha256(a)).toBe(sha256(a));
    expect(sha256(a)).toHaveLength(64);
  });
});

describe('auth input validation', () => {
  it('normalizes email and trims workspace name', () => {
    const parsed = registerSchema.parse({ email: '  Director@Empresa.COM ', password: 'secret123', workspaceName: '  Central  ' });
    expect(parsed.email).toBe('director@empresa.com');
    expect(parsed.workspaceName).toBe('Central');
  });

  it('rejects short passwords and passwords bcrypt would truncate', () => {
    expect(passwordSchema.safeParse('short').success).toBe(false);
    expect(passwordSchema.safeParse('x'.repeat(73)).success).toBe(false);
    expect(passwordSchema.safeParse('ñ'.repeat(40)).success).toBe(false); // 80 bytes
    expect(passwordSchema.safeParse('long-enough').success).toBe(true);
  });

  it('rejects a workspace name over 50 characters', () => {
    const result = registerSchema.safeParse({ email: 'a@b.co', password: 'secret123', workspaceName: 'x'.repeat(51) });
    expect(result.success).toBe(false);
  });
});
