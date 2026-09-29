import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient({
  // Errors surface through the API error handler; tests assert on them directly.
  log: process.env.NODE_ENV === 'test' ? [] : process.env.LOG_LEVEL === 'debug' ? ['query', 'warn', 'error'] : ['warn', 'error'],
});

export type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'>;
