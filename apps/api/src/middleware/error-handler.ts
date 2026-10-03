import { Prisma } from '@prisma/client';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';
import { captureError } from '../lib/sentry';
import type { AppEnv } from '../types';

function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof HTTPException) return new AppError(err.status, 'HTTP_ERROR', err.message);
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') return new AppError(409, 'CONFLICT', 'A record with these values already exists');
    if (err.code === 'P2025') return new AppError(404, 'NOT_FOUND', 'Resource not found');
  }
  return new AppError(500, 'INTERNAL_ERROR', 'Something went wrong on our side');
}

export function errorHandler(err: Error, c: Context<AppEnv>) {
  const appError = toAppError(err);
  if (appError.status >= 500) {
    logger.error('unhandled error', {
      requestId: c.get('requestId'),
      endpoint: c.req.path,
      userId: c.get('user')?.id,
      error: err,
    });
    captureError(err, { requestId: c.get('requestId'), endpoint: c.req.routePath, userId: c.get('user')?.id });
  }
  if (appError.status === 429) {
    const retry = (appError.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
    if (retry) c.header('Retry-After', String(retry));
  }
  return c.json(
    {
      error: {
        code: appError.code,
        message: appError.message,
        ...(appError.details !== undefined ? { details: appError.details } : {}),
        requestId: c.get('requestId'),
      },
    },
    appError.status,
  );
}

export function notFoundHandler(c: Context<AppEnv>) {
  return c.json(
    { error: { code: 'NOT_FOUND', message: `Route ${c.req.method} ${c.req.path} not found`, requestId: c.get('requestId') } },
    404,
  );
}
