import { serve } from '@hono/node-server';
import { createApp } from './app';
import { env } from './config/env';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { closeRedis, getRedis } from './lib/redis';

const app = createApp();
getRedis(); // start connecting early; the API works without it

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info('api listening', { port: info.port, env: env.NODE_ENV });
});

async function shutdown(signal: string) {
  logger.info('shutting down', { signal });
  server.close();
  await Promise.allSettled([prisma.$disconnect(), closeRedis()]);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (error) => logger.error('unhandled rejection', { error }));
