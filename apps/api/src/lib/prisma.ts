import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient({
  log: process.env.LOG_LEVEL === 'debug' ? ['query', 'warn', 'error'] : ['warn', 'error'],
});

export type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'>;
