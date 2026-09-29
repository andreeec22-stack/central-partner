import jwt from 'jsonwebtoken';
import type { Role } from '@prisma/client';
import { env } from '../config/env';

export interface AccessTokenClaims {
  sub: string; // user id
  wid: string; // workspace id
  sid: string; // session id
  role: Role;
}

const ISSUER = 'central-partner';
const AUDIENCE = 'central-partner-api';

export function signAccessToken(claims: AccessTokenClaims): string {
  return jwt.sign(claims, env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
    issuer: ISSUER,
    audience: AUDIENCE,
  });
}

// Returns null for any invalid/expired token; callers turn that into a 401.
export function verifyAccessToken(token: string): AccessTokenClaims | null {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (typeof payload === 'string') return null;
    const { sub, wid, sid, role } = payload as Partial<AccessTokenClaims>;
    if (!sub || !wid || !sid || !role) return null;
    return { sub, wid, sid, role };
  } catch {
    return null;
  }
}
