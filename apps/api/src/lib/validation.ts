import type { Context } from 'hono';
import type { ZodType, ZodTypeDef } from 'zod';
import { badRequest, notFound, validationError } from './errors';

function issuesOf(error: { issues: { path: (string | number)[]; message: string }[] }) {
  return error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
}

export async function parseJson<T>(c: Context, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest('Request body must be valid JSON');
  }
  const result = schema.safeParse(body);
  if (!result.success) throw validationError('Invalid request body', issuesOf(result.error));
  return result.data;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A malformed id can't match anything, so it's a 404 — not a DB error.
export function idParam(c: Context, name = 'id', entity = 'Resource'): string {
  const value = c.req.param(name);
  if (!value || !UUID.test(value)) throw notFound(entity);
  return value;
}

export function parseQuery<T>(c: Context, schema: ZodType<T, ZodTypeDef, unknown>): T {
  const result = schema.safeParse(c.req.query());
  if (!result.success) throw validationError('Invalid query parameters', issuesOf(result.error));
  return result.data;
}
