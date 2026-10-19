/**
 * HTTP plumbing for every Edge Function: a tiny router, JSON responses, CORS, request ids, bounded body reading,
 * fetch timeouts and background work.
 *
 * Paths: the router accepts `/functions/v1/<fn>/<route>` (direct gateway URL), `/<fn>/<route>` (what the edge
 * runtime passes to the worker) and `/<route>`, so the same table works locally, hosted and in unit tests.
 */
import type { ZodType } from 'zod';
import type { ApiError } from '@shared/contracts/index.ts';
import { HttpError, httpError, toHttpError } from './errors.ts';
import { createLogger, errorFields, type Logger } from './log.ts';

// ---------------------------------------------------------------------------------------------------------------
// Responses

export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  const h = new Headers(headers);
  h.set('content-type', JSON_CONTENT_TYPE);
  return new Response(JSON.stringify(body), { status, headers: h });
}

export function errorJson(err: HttpError): Response {
  return json(err.body satisfies ApiError, err.status, err.headers);
}

export function noContent(headers: HeadersInit = {}): Response {
  return new Response(null, { status: 204, headers });
}

// ---------------------------------------------------------------------------------------------------------------
// CORS (the Web Lab calls the functions from a browser; auth is a bearer header, never cookies)

/** Headers the Supabase SDKs send (mirrors `@supabase/supabase-js/cors` 2.117.2) plus our request id. */
export const CORS_ALLOW_HEADERS = [
  'authorization',
  'x-client-info',
  'apikey',
  'content-type',
  'x-retry-count',
  'traceparent',
  'tracestate',
  'baggage',
  'x-request-id',
];

export interface CorsOptions {
  /** `'*'` (default) or an explicit origin allowlist. */
  origins?: '*' | readonly string[];
  methods?: readonly string[];
  maxAgeSec?: number;
}

export function corsHeaders(req: Request, options: CorsOptions = {}): Record<string, string> {
  const origins = options.origins ?? '*';
  const origin = req.headers.get('origin');
  let allowOrigin: string | null = null;
  if (origins === '*') allowOrigin = '*';
  else if (origin && origins.includes(origin)) allowOrigin = origin;
  if (allowOrigin === null) return {};
  const headers: Record<string, string> = {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-headers': CORS_ALLOW_HEADERS.join(', '),
    'access-control-allow-methods': (options.methods ?? ['GET', 'POST', 'OPTIONS']).join(', '),
    'access-control-expose-headers': 'x-request-id, retry-after',
    'access-control-max-age': String(options.maxAgeSec ?? 86400),
  };
  if (allowOrigin !== '*') headers['vary'] = 'Origin';
  return headers;
}

// ---------------------------------------------------------------------------------------------------------------
// Request ids

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,64}$/;

/** The caller's `x-request-id` when it is safe to echo, otherwise a fresh UUID. */
export function requestIdFor(req: Request): string {
  const incoming = req.headers.get('x-request-id');
  return incoming && REQUEST_ID_RE.test(incoming) ? incoming : crypto.randomUUID();
}

// ---------------------------------------------------------------------------------------------------------------
// Bodies

/** Default body cap for JSON routes; `/analyze/prepare` passes `POSE_V1_MAX_BYTES`. */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

export interface ReadBodyOptions {
  maxBytes?: number;
}

/**
 * Reads the body as bytes, failing with 413 `payload_too_large` as soon as it exceeds `maxBytes` (checked against
 * `content-length` first, then while streaming, so a lying or chunked client cannot make us buffer more).
 */
export async function readBytes(req: Request, options: ReadBodyOptions = {}): Promise<Uint8Array> {
  const max = options.maxBytes ?? DEFAULT_MAX_BODY_BYTES;
  const declared = req.headers.get('content-length');
  if (declared !== null && Number(declared) > max) {
    await req.body?.cancel().catch(() => {});
    throw httpError('payload_too_large', `body exceeds ${max} bytes`);
  }
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw httpError('payload_too_large', `body exceeds ${max} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export async function readText(req: Request, options: ReadBodyOptions = {}): Promise<string> {
  const bytes = await readBytes(req, options);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw httpError('invalid_payload', 'body is not valid UTF-8');
  }
}

/** Parses a JSON body (413 when too large, 422 `invalid_payload` when empty or malformed). */
export async function readJson(req: Request, options: ReadBodyOptions = {}): Promise<unknown> {
  const contentType = req.headers.get('content-type');
  if (contentType && !/^application\/(?:[\w.+-]+\+)?json\b/i.test(contentType)) {
    await req.body?.cancel().catch(() => {});
    throw httpError('invalid_payload', 'content-type must be application/json');
  }
  const text = await readText(req, options);
  if (text.trim() === '') throw httpError('invalid_payload', 'empty body');
  try {
    return JSON.parse(text);
  } catch {
    throw httpError('invalid_payload', 'body is not valid JSON');
  }
}

/** Formats the first few Zod issues as `path: message` (never echoes values). */
export function describeIssues(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  return issues
    .slice(0, 5)
    .map((i) => `${i.path.length ? i.path.map(String).join('.') : '(root)'}: ${i.message}`)
    .join('; ');
}

/** `readJson` + schema validation; a schema failure is 422 `invalid_payload` with a short path summary. */
export async function parseJson<T>(req: Request, schema: ZodType<T>, options: ReadBodyOptions = {}): Promise<T> {
  const raw = await readJson(req, options);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw httpError('invalid_payload', describeIssues(parsed.error.issues));
  return parsed.data;
}

// ---------------------------------------------------------------------------------------------------------------
// Outbound fetch with a timeout (DESIGN §6.1: every fetch has AbortSignal.timeout)

export type FetchLike = (input: Request | URL | string, init?: RequestInit) => Promise<Response>;

/** Wraps `fetch` so each call aborts after `timeoutMs` (combined with any caller signal). */
export function fetchWithTimeout(timeoutMs: number, baseFetch: FetchLike = fetch): FetchLike {
  return (input, init = {}) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return baseFetch(input, { ...init, signal });
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Background work (`EdgeRuntime.waitUntil` when present)

interface EdgeRuntimeLike {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Keeps `task` alive after the response is sent. Errors are logged, never thrown. Outside the edge runtime (tests,
 * scripts) the promise simply runs. Returns the guarded promise so tests can await it.
 */
export function runInBackground(task: Promise<unknown>, log: Logger): Promise<void> {
  const guarded = task.then(
    () => {},
    (err) => log.error('background task failed', errorFields(err)),
  );
  const runtime = (globalThis as { EdgeRuntime?: EdgeRuntimeLike }).EdgeRuntime;
  if (runtime && typeof runtime.waitUntil === 'function') runtime.waitUntil(guarded);
  return guarded;
}

// ---------------------------------------------------------------------------------------------------------------
// Router

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RouteContext {
  /** Function name (`analyze`, `cron`, …). */
  fn: string;
  /** The matched route pattern, e.g. `/prepare` or `/items/:id`. */
  route: string;
  /** The path after the function prefix, e.g. `/prepare`. */
  path: string;
  params: Record<string, string>;
  url: URL;
  requestId: string;
  /** Logger carrying `fn`, `req_id` and `route`. */
  log: Logger;
}

export type Handler = (req: Request, ctx: RouteContext) => Response | Promise<Response>;

export interface RouteDef {
  method: HttpMethod;
  pattern: string;
  handler: Handler;
}

export function route(method: HttpMethod, pattern: string, handler: Handler): RouteDef {
  if (!pattern.startsWith('/')) throw new Error(`route pattern must start with '/': ${pattern}`);
  return { method, pattern: normalizePath(pattern), handler };
}

export interface RouterOptions {
  fn: string;
  /** CORS settings, or `false` to send no CORS headers (default: `{origins: '*'}`). */
  cors?: CorsOptions | false;
  /** Base logger (default: JSON console logger). */
  logger?: Logger;
}

function normalizePath(path: string): string {
  const collapsed = path.replace(/\/{2,}/g, '/');
  const trimmed = collapsed.length > 1 && collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed;
  return trimmed === '' ? '/' : trimmed;
}

/** Strips `/functions/v1` and `/<fn>` from a pathname (both optional). */
export function stripFunctionPrefix(pathname: string, fn: string): string {
  let path = normalizePath(pathname);
  if (path === '/functions/v1' || path.startsWith('/functions/v1/')) path = path.slice('/functions/v1'.length) || '/';
  if (path === `/${fn}` || path.startsWith(`/${fn}/`)) path = path.slice(fn.length + 1) || '/';
  return normalizePath(path);
}

function matchPattern(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/');
  const s = path.split('/');
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) {
      if (s[i] === '') return null;
      try {
        params[p[i].slice(1)] = decodeURIComponent(s[i]);
      } catch {
        return null;
      }
    } else if (p[i] !== s[i]) {
      return null;
    }
  }
  return params;
}

/**
 * Builds the `Deno.serve` handler. Behaviour:
 * - `OPTIONS` → 204 preflight with CORS headers;
 * - known path, wrong method → 405 `method_not_allowed` with `Allow`; unknown path → 404 `not_found`;
 * - a thrown `HttpError` → its JSON body and status; anything else → 500 `internal` (logged, not leaked);
 * - every response carries `x-request-id` and the CORS headers; one access log line per request.
 */
export function createRouter(options: RouterOptions, routes: readonly RouteDef[]): (req: Request) => Promise<Response> {
  const baseLog = options.logger ?? createLogger();
  const fnLog = baseLog.child({ fn: options.fn });

  return async (req: Request): Promise<Response> => {
    const started = performance.now();
    const requestId = requestIdFor(req);
    const url = new URL(req.url);
    const path = stripFunctionPrefix(url.pathname, options.fn);
    let routePattern = '(unmatched)';
    let log = fnLog.child({ req_id: requestId });
    const method = req.method.toUpperCase();

    let response: Response;
    try {
      if (method === 'OPTIONS') {
        response = noContent();
      } else {
        const candidates = routes
          .map((r) => ({ r, params: matchPattern(r.pattern, path) }))
          .filter((c) => c.params !== null);
        const hit = candidates.find((c) => c.r.method === method || (method === 'HEAD' && c.r.method === 'GET'));
        if (!hit) {
          if (candidates.length > 0) {
            const allow = [...new Set(candidates.map((c) => c.r.method)), 'OPTIONS'].join(', ');
            throw httpError('method_not_allowed', undefined, { headers: { allow } });
          }
          throw httpError('not_found');
        }
        routePattern = hit.r.pattern;
        log = log.child({ route: routePattern });
        response = await hit.r.handler(req, {
          fn: options.fn,
          route: routePattern,
          path,
          params: hit.params ?? {},
          url,
          requestId,
          log,
        });
      }
    } catch (err) {
      const httpErr = toHttpError(err);
      if (httpErr.status >= 500) {
        log.error('request failed', { code: httpErr.code, ...errorFields(httpErr.cause ?? err) });
      }
      // drain an unread body so the runtime can reuse the connection
      await req.body?.cancel().catch(() => {});
      response = errorJson(httpErr);
    }

    const headers = new Headers(response.headers);
    headers.set('x-request-id', requestId);
    if (options.cors !== false) {
      for (const [k, v] of Object.entries(corsHeaders(req, options.cors ?? {}))) headers.set(k, v);
    }
    const final = new Response(method === 'HEAD' ? null : response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
    if (method !== 'OPTIONS') {
      log.info('request', {
        method,
        route: routePattern,
        status: final.status,
        ms: Math.round(performance.now() - started),
      });
    }
    return final;
  };
}
