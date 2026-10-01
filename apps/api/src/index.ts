import type { Server as HttpServer } from 'node:http';
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { env } from './config/env';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { closeRedis, getRedis } from './lib/redis';
import { attachSocketServer } from './realtime/socket-server';
import { startWeekScheduler } from './modules/weeks/weeks.service';
import { startSurveyScheduler } from './modules/surveys/surveys.service';
import { startReportCleanup } from './modules/reports/reports.service';

const app = createApp();
getRedis(); // start connecting early; the API works without it

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info('api listening', { port: info.port, env: env.NODE_ENV });
});
const io = attachSocketServer(server as HttpServer);

const stopJobs: (() => void)[] = [];
if (env.SCHEDULERS_ENABLED) {
  // Each workspace gets its new week within a minute of Monday 00:00 local time.
  stopJobs.push(startWeekScheduler());
  // Scheduled surveys open within a minute of their start date.
  stopJobs.push(startSurveyScheduler());
  // Expired weekly reports (30 days) lose their file; checked hourly.
  stopJobs.push(startReportCleanup());
} else {
  logger.info('schedulers disabled (SCHEDULERS_ENABLED=false)');
}

async function shutdown(signal: string) {
  logger.info('shutting down', { signal });
  for (const stop of stopJobs) stop();
  await new Promise<void>((resolve) => io.close(() => resolve()));
  await Promise.allSettled([prisma.$disconnect(), closeRedis()]);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (error) => logger.error('unhandled rejection', { error }));
