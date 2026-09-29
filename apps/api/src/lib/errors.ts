import type { ContentfulStatusCode } from 'hono/utils/http-status';

// Every API error leaves the server as { error: { code, message, details?, requestId } }.
export class AppError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = 'Authentication required', code = 'UNAUTHORIZED') =>
  new AppError(401, code, message);
export const forbidden = (message = 'You do not have permission to do this') => new AppError(403, 'FORBIDDEN', message);
export const notFound = (entity = 'Resource') => new AppError(404, 'NOT_FOUND', `${entity} not found`);
export const conflict = (message: string, code = 'CONFLICT', details?: unknown) =>
  new AppError(409, code, message, details);
export const validationError = (message: string, details?: unknown) =>
  new AppError(422, 'VALIDATION_ERROR', message, details);
export const tooManyRequests = (retryAfterSeconds: number) =>
  new AppError(429, 'RATE_LIMITED', 'Too many requests, please slow down', { retryAfterSeconds });
