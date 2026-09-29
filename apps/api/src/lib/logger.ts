import { env } from '../config/env';

// Structured JSON logs (Gap 17): one line per event, read by Railway's log viewer.
type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

function serializeError(err: unknown) {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: env.NODE_ENV === 'production' ? undefined : err.stack };
  }
  return { message: String(err) };
}

function write(level: Level, msg: string, fields?: LogFields) {
  if (order[level] < order[env.LOG_LEVEL]) return;
  if (env.NODE_ENV === 'test' && level !== 'error') return;
  const entry: LogFields = { timestamp: new Date().toISOString(), level, msg, ...fields };
  if (entry.error !== undefined) entry.error = serializeError(entry.error);
  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const logger = {
  debug: (msg: string, fields?: LogFields) => write('debug', msg, fields),
  info: (msg: string, fields?: LogFields) => write('info', msg, fields),
  warn: (msg: string, fields?: LogFields) => write('warn', msg, fields),
  error: (msg: string, fields?: LogFields) => write('error', msg, fields),
};
