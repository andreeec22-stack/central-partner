import bcrypt from 'bcryptjs';
import { env } from '../config/env';

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, env.BCRYPT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// Compared against when the email is unknown, so response time doesn't reveal
// which accounts exist.
let dummyHash: string | undefined;
export async function burnPasswordCheck(plain: string): Promise<void> {
  dummyHash ??= await bcrypt.hash('timing-equalizer', env.BCRYPT_ROUNDS);
  await bcrypt.compare(plain, dummyHash);
}
