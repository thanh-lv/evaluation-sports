/**
 * Typed HTTP errors (DESIGN-v1.0 §6.1 `errors.ts`): every non-2xx response body is a contracts `ApiError`
 * (`{code, message?, tips?, limit?, used?, resetsAt?}`) and its status comes from `httpStatusFor(code)`.
 *
 * Handlers throw `HttpError`; the router turns it into a JSON response. Anything else thrown becomes a generic
 * 500 `internal` whose message never leaves the server.
 */
import {
  API_ERROR_STATUS,
  type ApiError,
  apiError,
  type ApiErrorCode,
  httpStatusFor,
} from '@shared/contracts/index.ts';

export interface HttpErrorOptions {
  tips?: readonly string[];
  /** `quota_exceeded` / `in_flight` extras. */
  extra?: Pick<ApiError, 'limit' | 'used' | 'resetsAt'>;
  /** Extra response headers (e.g. `Allow`, `Retry-After`). */
  headers?: Record<string, string>;
  /** Internal cause, logged but never sent. */
  cause?: unknown;
}

export class HttpError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly body: ApiError;
  readonly headers: Record<string, string>;

  constructor(code: ApiErrorCode, message?: string, options: HttpErrorOptions = {}) {
    super(message ?? code, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'HttpError';
    this.code = code;
    this.status = httpStatusFor(code);
    this.body = apiError(code, message, options.tips, options.extra);
    this.headers = { ...(options.headers ?? {}) };
  }
}

export function httpError(code: ApiErrorCode, message?: string, options?: HttpErrorOptions): HttpError {
  return new HttpError(code, message, options);
}

export function isHttpError(err: unknown): err is HttpError {
  return err instanceof HttpError;
}

export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && Object.hasOwn(API_ERROR_STATUS, value);
}

/** Missing or invalid server configuration: a 500 for the caller, a clear log line for the operator. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Converts any thrown value into the HttpError that will be sent (unknown errors → 500 `internal`). */
export function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  return new HttpError('internal', 'internal error', { cause: err });
}

/**
 * Maps a PostgREST error from a client-style RPC. The SQL functions raise `SQLSTATE 'PTnnn'` with the ApiErrorCode
 * as the message (docs/database.md, "Conventions"); everything else is an internal error.
 */
export function fromPostgrestError(err: { code?: string; message?: string } | null | undefined): HttpError {
  const message = err?.message ?? '';
  if (err?.code?.startsWith('PT') && isApiErrorCode(message)) return new HttpError(message, undefined, { cause: err });
  return new HttpError('internal', 'internal error', { cause: err });
}

/**
 * Maps a `{ok:false, code, limit?, used?, resets_at?}` result from a `private.*` function (e.g. reserve_for_submit)
 * to an HttpError. Unknown codes become `internal`.
 */
export function fromRpcFailure(result: {
  code?: unknown;
  limit?: unknown;
  used?: unknown;
  resets_at?: unknown;
  resetsAt?: unknown;
}): HttpError {
  if (!isApiErrorCode(result.code)) {
    return new HttpError('internal', 'internal error', { cause: result });
  }
  const extra: Pick<ApiError, 'limit' | 'used' | 'resetsAt'> = {};
  if (typeof result.limit === 'number') extra.limit = result.limit;
  if (typeof result.used === 'number') extra.used = result.used;
  const resets = result.resetsAt !== undefined ? result.resetsAt : result.resets_at;
  if (typeof resets === 'string' || resets === null) extra.resetsAt = resets;
  return new HttpError(result.code, undefined, { extra: Object.keys(extra).length ? extra : undefined });
}
