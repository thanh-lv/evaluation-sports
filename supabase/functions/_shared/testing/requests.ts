/** Request builders and response assertions for handler tests. */
import { assert, assertEquals } from '@std/assert';
import type { ApiError, ApiErrorCode } from '@shared/contracts/index.ts';
import { httpStatusFor } from '@shared/contracts/index.ts';

export interface BuildRequestOptions {
  method?: string;
  /** JSON body (sets content-type). */
  json?: unknown;
  /** Raw body (string or bytes). */
  body?: BodyInit;
  headers?: Record<string, string>;
  /** Bearer token for `Authorization`. */
  token?: string;
  /** Function name used for the URL prefix (default `analyze`). */
  fn?: string;
  /** `gateway` → `/functions/v1/<fn>/…` (default), `runtime` → `/<fn>/…`, `bare` → path only. */
  prefix?: 'gateway' | 'runtime' | 'bare';
  origin?: string;
}

export function buildRequest(path: string, options: BuildRequestOptions = {}): Request {
  const fn = options.fn ?? 'analyze';
  const prefix = options.prefix ?? 'gateway';
  const base = prefix === 'gateway' ? `/functions/v1/${fn}` : prefix === 'runtime' ? `/${fn}` : '';
  const headers = new Headers(options.headers ?? {});
  let body: BodyInit | undefined = options.body;
  if (options.json !== undefined) {
    body = JSON.stringify(options.json);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  }
  if (options.token) headers.set('authorization', `Bearer ${options.token}`);
  if (options.origin) headers.set('origin', options.origin);
  const method = options.method ?? (body !== undefined ? 'POST' : 'GET');
  return new Request(`http://localhost${base}${path}`, { method, headers, body });
}

/** POST with a JSON body. */
export function jsonRequest(path: string, json: unknown, options: Omit<BuildRequestOptions, 'json'> = {}): Request {
  return buildRequest(path, { ...options, method: options.method ?? 'POST', json });
}

export async function readJsonResponse<T = unknown>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`response is not JSON (status ${res.status}): ${text.slice(0, 200)}`);
  }
}

/** Asserts the status matches `code` and the body is an ApiError with that code; returns the body. */
export async function assertApiError(res: Response, code: ApiErrorCode): Promise<ApiError> {
  const body = await readJsonResponse<ApiError>(res);
  assertEquals(body.code, code, `expected error ${code}, got ${JSON.stringify(body)}`);
  assertEquals(res.status, httpStatusFor(code));
  assert(res.headers.get('content-type')?.startsWith('application/json'));
  return body;
}
