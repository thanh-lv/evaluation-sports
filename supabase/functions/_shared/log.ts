/**
 * Structured JSON logs without PII (DESIGN-v1.0 §6.1 `log.ts`).
 *
 * One JSON object per line: `{ts, level, msg, fn?, req_id?, ...fields}`. Fields are scrubbed before writing:
 * - keys that can carry secrets or personal data (emails, tokens, keypoints, images, …) are replaced by `[redacted]`;
 * - user ids (`userId`, `user_id`, `uid`, …) are replaced by a short salted hash under `user`/`<key>_hash`;
 * - strings that look like emails or JWTs are masked, long strings are truncated, long arrays are summarised
 *   (so coordinate arrays never reach the log).
 */
import { createHash } from 'node:crypto';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;
export type LogSink = (level: LogLevel, line: string) => void;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every line. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  /** Lowest level written (default `info`). */
  level?: LogLevel;
  /** Where lines go (default: console.log / console.error for `error`). */
  sink?: LogSink;
  /** Salt for user-id hashes (default: a fixed namespace; set LOG_PEPPER in production). */
  pepper?: string;
}

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keys whose values are never logged (compared case-insensitively, without `_`/`-`). */
const REDACT_KEYS = new Set(
  [
    'email',
    'phone',
    'password',
    'token',
    'accesstoken',
    'refreshtoken',
    'anonaccesstoken',
    'idtoken',
    'authorization',
    'authorizationcode',
    'apikey',
    'secret',
    'cookie',
    'signedpayload',
    'signedtransaction',
    'signedtransactioninfo',
    'signedrenewalinfo',
    'devicechecktoken',
    'ciphertext',
    'keypoints',
    'kp',
    'image',
    'images',
    'jpeg',
    'prompt',
    'body',
    'comment',
  ],
);

/** Keys holding a user id: logged only as a salted hash. */
const USER_ID_KEYS = new Set(['userid', 'uid', 'user', 'sub', 'fromuserid', 'touserid', 'anonuserid']);

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const JWT_RE = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const API_KEY_RE = /sb_(?:secret|publishable)_[A-Za-z0-9_-]+|sk-ant-[A-Za-z0-9_-]+/g;
const MAX_STRING = 500;
const MAX_ARRAY = 20;
const MAX_DEPTH = 4;
const DEFAULT_PEPPER = 'racketcoach.log.v1';

function normKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

/** Short, salted, one-way user-id hash for logs (lower-cased first, so iOS/Postgres spellings agree). */
export function hashUserId(userId: string, pepper: string = DEFAULT_PEPPER): string {
  return createHash('sha256').update(`${pepper}:${userId.toLowerCase()}`).digest('hex').slice(0, 16);
}

/** Masks emails, JWTs and API keys inside free text and truncates it. */
export function scrubText(text: string): string {
  const masked = text.replace(JWT_RE, '[jwt]').replace(API_KEY_RE, '[key]').replace(EMAIL_RE, '[email]');
  return masked.length > MAX_STRING ? `${masked.slice(0, MAX_STRING)}…` : masked;
}

function scrubValue(value: unknown, depth: number, pepper: string): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return errorFields(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array || value instanceof ArrayBuffer || value instanceof Blob) return '[binary]';
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY) return `[array(${value.length})]`;
    if (depth >= MAX_DEPTH) return '[array]';
    return value.map((v) => scrubValue(v, depth + 1, pepper));
  }
  if (typeof value === 'object') {
    if (depth >= MAX_DEPTH) return '[object]';
    return scrubFields(value as LogFields, pepper, depth + 1);
  }
  return String(value);
}

/** Applies the PII rules to a field bag (exported for events.ts and tests). */
export function scrubFields(fields: LogFields, pepper: string = DEFAULT_PEPPER, depth = 0): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const k = normKey(key);
    if (REDACT_KEYS.has(k)) {
      out[key] = '[redacted]';
    } else if (USER_ID_KEYS.has(k) && typeof value === 'string') {
      out[k === 'userid' || k === 'uid' || k === 'user' ? 'user' : `${key}_hash`] = hashUserId(value, pepper);
    } else {
      out[key] = scrubValue(value, depth, pepper);
    }
  }
  return out;
}

/** `{err_name, err_msg, err_code?}` for an unknown thrown value; the message is scrubbed and truncated. */
export function errorFields(err: unknown): LogFields {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    const fields: LogFields = { err_name: err.name, err_msg: scrubText(err.message) };
    if (typeof code === 'string' || typeof code === 'number') fields.err_code = code;
    return fields;
  }
  return { err_name: typeof err, err_msg: scrubText(String(err)) };
}

const consoleSink: LogSink = (level, line) => {
  if (level === 'error') console.error(line);
  else console.log(line);
};

export function parseLogLevel(value: string | undefined | null, fallback: LogLevel = 'info'): LogLevel {
  const v = (value ?? '').trim().toLowerCase();
  return v in LEVEL_RANK ? (v as LogLevel) : fallback;
}

export function createLogger(base: LogFields = {}, options: LoggerOptions = {}): Logger {
  const minRank = LEVEL_RANK[options.level ?? 'info'];
  const sink = options.sink ?? consoleSink;
  const pepper = options.pepper ?? DEFAULT_PEPPER;
  const scrubbedBase = scrubFields(base, pepper);

  const write = (level: LogLevel, msg: string, fields?: LogFields) => {
    if (LEVEL_RANK[level] < minRank) return;
    const line = {
      ts: new Date().toISOString(),
      level,
      msg: scrubText(msg),
      ...scrubbedBase,
      ...(fields ? scrubFields(fields, pepper) : {}),
    };
    try {
      sink(level, JSON.stringify(line));
    } catch {
      // logging must never throw
    }
  };

  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    child: (fields) => createLogger({ ...base, ...fields }, options),
  };
}

/** A logger that drops everything (default for unit tests that do not inspect logs). */
export const silentLogger: Logger = createLogger({}, { sink: () => {} });
