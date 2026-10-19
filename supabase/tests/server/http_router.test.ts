/** Router, responses, CORS, request ids, body limits and background work (`_shared/http.ts`). */
import { assert, assertEquals, assertMatch, assertRejects } from '@std/assert';
import { z } from 'zod';
import {
  corsHeaders,
  createRouter,
  fetchWithTimeout,
  json,
  parseJson,
  readBytes,
  readJson,
  requestIdFor,
  route,
  runInBackground,
  stripFunctionPrefix,
} from '@shared/http.ts';
import { ConfigError, HttpError, httpError } from '@shared/errors.ts';
import { assertApiError, buildRequest, captureLogger, jsonRequest, readJsonResponse } from '@shared/testing/index.ts';

function testRouter(options: { cors?: false | { origins: string[] } } = {}) {
  const { log, lines } = captureLogger();
  const handler = createRouter({ fn: 'analyze', logger: log, cors: options.cors }, [
    route('GET', '/catalog', () => json({ ok: true })),
    route('POST', '/prepare', async (req) => json({ got: await readJson(req, { maxBytes: 64 }) })),
    route('POST', '/items/:id', (_req, ctx) => json({ id: ctx.params.id, route: ctx.route, path: ctx.path })),
    route('GET', '/', () => json({ root: true })),
    route('GET', '/quota', () => {
      throw httpError('quota_exceeded', 'limit reached', { extra: { limit: 3, used: 3, resetsAt: null } });
    }),
    route('GET', '/boom', () => {
      throw new Error('db password=hunter2 leaked?');
    }),
    route('GET', '/config', () => {
      throw new ConfigError('missing environment: CRON_SECRET');
    }),
    route('GET', '/ctx', (_req, ctx) => {
      ctx.log.info('inside', { analysis_id: 'a1' });
      return json({ requestId: ctx.requestId, fn: ctx.fn });
    }),
  ]);
  return { handler, lines };
}

Deno.test('stripFunctionPrefix handles gateway, runtime and bare paths', () => {
  assertEquals(stripFunctionPrefix('/functions/v1/analyze/prepare', 'analyze'), '/prepare');
  assertEquals(stripFunctionPrefix('/analyze/prepare', 'analyze'), '/prepare');
  assertEquals(stripFunctionPrefix('/prepare', 'analyze'), '/prepare');
  assertEquals(stripFunctionPrefix('/functions/v1/analyze', 'analyze'), '/');
  assertEquals(stripFunctionPrefix('/analyze/', 'analyze'), '/');
  assertEquals(stripFunctionPrefix('//analyze//prepare/', 'analyze'), '/prepare');
  // a route that merely starts with the function name is not a prefix
  assertEquals(stripFunctionPrefix('/analyzer/x', 'analyze'), '/analyzer/x');
});

Deno.test('router matches the same route under every URL prefix', async () => {
  const { handler } = testRouter();
  for (const prefix of ['gateway', 'runtime', 'bare'] as const) {
    const res = await handler(buildRequest('/catalog', { prefix }));
    assertEquals(res.status, 200, prefix);
    assertEquals(await res.json(), { ok: true });
  }
  const root = await handler(buildRequest('', { prefix: 'gateway' }));
  assertEquals(await root.json(), { root: true });
});

Deno.test('router passes decoded params, route and path', async () => {
  const { handler } = testRouter();
  const res = await handler(buildRequest('/items/a%20b', { method: 'POST' }));
  assertEquals(await res.json(), { id: 'a b', route: '/items/:id', path: '/items/a%20b' });
});

Deno.test('unknown path is 404 not_found; wrong method is 405 with Allow', async () => {
  const { handler } = testRouter();
  await assertApiError(await handler(buildRequest('/nope')), 'not_found');
  const res = await handler(buildRequest('/catalog', { method: 'POST', body: '{}' }));
  await assertApiError(res, 'method_not_allowed');
  assertEquals(res.headers.get('allow'), 'GET, OPTIONS');
  // params never match an empty segment
  await assertApiError(await handler(buildRequest('/items/', { method: 'POST' })), 'not_found');
});

Deno.test('HEAD runs the GET route without a body', async () => {
  const { handler } = testRouter();
  const res = await handler(buildRequest('/catalog', { method: 'HEAD' }));
  assertEquals(res.status, 200);
  assertEquals(await res.text(), '');
});

Deno.test('HttpError becomes its ApiError body and status, with extras', async () => {
  const { handler } = testRouter();
  const body = await assertApiError(await handler(buildRequest('/quota')), 'quota_exceeded');
  assertEquals(body, { code: 'quota_exceeded', message: 'limit reached', limit: 3, used: 3, resetsAt: null });
});

Deno.test('unknown errors and ConfigError become 500 internal without leaking the message', async () => {
  const { handler, lines } = testRouter();
  for (const path of ['/boom', '/config']) {
    const res = await handler(buildRequest(path));
    const body = await assertApiError(res, 'internal');
    assert(!JSON.stringify(body).includes('hunter2'));
    assert(!JSON.stringify(body).includes('CRON_SECRET'));
  }
  const errors = lines.filter((l) => l.level === 'error');
  assertEquals(errors.length, 2);
  assertEquals(errors[0].entry.err_name, 'Error');
  assertEquals(errors[1].entry.err_name, 'ConfigError');
  assertMatch(String(errors[1].entry.err_msg), /CRON_SECRET/); // the operator sees the variable name
});

Deno.test('every response carries x-request-id; a safe incoming id is echoed', async () => {
  const { handler } = testRouter();
  const fresh = await handler(buildRequest('/catalog'));
  assertMatch(fresh.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
  await fresh.body?.cancel();
  const echoed = await handler(buildRequest('/nope', { headers: { 'x-request-id': 'client-req-12345' } }));
  assertEquals(echoed.headers.get('x-request-id'), 'client-req-12345');
  await echoed.body?.cancel();
  const unsafe = requestIdFor(buildRequest('/x', { headers: { 'x-request-id': 'bad id <script>' } }));
  assertMatch(unsafe, /^[0-9a-f-]{36}$/);
});

Deno.test('ctx exposes request id and a child logger tagged with fn, req_id and route', async () => {
  const { handler, lines } = testRouter();
  const res = await handler(buildRequest('/ctx'));
  const body = await readJsonResponse<{ requestId: string; fn: string }>(res);
  assertEquals(body.fn, 'analyze');
  const inside = lines.find((l) => l.entry.msg === 'inside')!;
  assertEquals(inside.entry.fn, 'analyze');
  assertEquals(inside.entry.req_id, body.requestId);
  assertEquals(inside.entry.route, '/ctx');
  assertEquals(inside.entry.analysis_id, 'a1');
  const access = lines.find((l) => l.entry.msg === 'request')!;
  assertEquals(access.entry.status, 200);
  assertEquals(access.entry.method, 'GET');
  assertEquals(typeof access.entry.ms, 'number');
});

Deno.test('access log carries the error code for failed requests', async () => {
  const { handler, lines } = testRouter();
  await (await handler(buildRequest('/nope'))).body?.cancel();
  const access = lines.find((l) => l.entry.msg === 'request')!;
  assertEquals(access.entry.code, 'not_found');
  assertEquals(access.entry.status, 404);
});

Deno.test('CORS: preflight is 204 with allow headers; wildcard by default; allowlist mode', async () => {
  const { handler } = testRouter();
  const pre = await handler(buildRequest('/prepare', { method: 'OPTIONS', origin: 'http://localhost:5173' }));
  assertEquals(pre.status, 204);
  assertEquals(pre.headers.get('access-control-allow-origin'), '*');
  assertMatch(pre.headers.get('access-control-allow-headers') ?? '', /authorization/);
  assertMatch(pre.headers.get('access-control-allow-headers') ?? '', /x-client-info/);
  // CORS headers also on errors (so the browser can read the ApiError)
  const err = await handler(buildRequest('/nope', { origin: 'http://localhost:5173' }));
  assertEquals(err.headers.get('access-control-allow-origin'), '*');
  await err.body?.cancel();

  const strict = testRouter({ cors: { origins: ['https://lab.example'] } }).handler;
  const ok = await strict(buildRequest('/catalog', { origin: 'https://lab.example' }));
  assertEquals(ok.headers.get('access-control-allow-origin'), 'https://lab.example');
  assertEquals(ok.headers.get('vary'), 'Origin');
  await ok.body?.cancel();
  const other = await strict(buildRequest('/catalog', { origin: 'https://evil.example' }));
  assertEquals(other.headers.get('access-control-allow-origin'), null);
  await other.body?.cancel();

  const off = testRouter({ cors: false }).handler;
  const none = await off(buildRequest('/catalog', { origin: 'https://lab.example' }));
  assertEquals(none.headers.get('access-control-allow-origin'), null);
  await none.body?.cancel();
  assertEquals(corsHeaders(buildRequest('/x'), { origins: ['https://a'] }), {});
});

Deno.test('JSON body: parsed, 422 on malformed/empty/wrong content-type, 413 above the limit', async () => {
  const { handler } = testRouter();
  const ok = await handler(jsonRequest('/prepare', { a: 1 }));
  assertEquals(await ok.json(), { got: { a: 1 } });
  await assertApiError(await handler(buildRequest('/prepare', { method: 'POST', body: '{bad' })), 'invalid_payload');
  await assertApiError(await handler(buildRequest('/prepare', { method: 'POST', body: '' })), 'invalid_payload');
  await assertApiError(
    await handler(buildRequest('/prepare', { method: 'POST', body: '{}', headers: { 'content-type': 'text/plain' } })),
    'invalid_payload',
  );
  await assertApiError(await handler(jsonRequest('/prepare', { pad: 'x'.repeat(100) })), 'payload_too_large');
});

function streamOf(chunks: number, size: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent++ >= chunks) controller.close();
      else controller.enqueue(new Uint8Array(size).fill(0x20));
    },
  });
}

Deno.test('readBytes enforces the limit from content-length and while streaming', async () => {
  const declared = new Request('http://x/', { method: 'POST', body: 'abc', headers: { 'content-length': '999999' } });
  await assertRejects(() => readBytes(declared, { maxBytes: 10 }), HttpError, 'body exceeds 10 bytes');

  // chunked body without content-length: stops reading once past the cap
  const chunked = new Request('http://x/', { method: 'POST', body: streamOf(100, 1000) });
  const err = await assertRejects(() => readBytes(chunked, { maxBytes: 5000 }), HttpError);
  assertEquals(err.code, 'payload_too_large');
  assertEquals(err.status, 413);

  const fits = new Request('http://x/', { method: 'POST', body: streamOf(5, 1000) });
  assertEquals((await readBytes(fits, { maxBytes: 5000 })).length, 5000);
  assertEquals((await readBytes(new Request('http://x/'))).length, 0);
});

Deno.test('parseJson validates with zod and reports paths, not values', async () => {
  const schema = z.object({ analysisId: z.string().uuid(), n: z.number().int() });
  const good = await parseJson(jsonRequest('/x', { analysisId: crypto.randomUUID(), n: 2 }), schema);
  assertEquals(good.n, 2);
  const err = await assertRejects(
    () => parseJson(jsonRequest('/x', { analysisId: 'secret-value', n: 1.5 }), schema),
    HttpError,
  );
  assertEquals(err.code, 'invalid_payload');
  assertMatch(err.message, /analysisId/);
  assertMatch(err.message, /n:/);
  assert(!err.message.includes('secret-value'));
});

Deno.test('fetchWithTimeout aborts slow calls and keeps the caller signal', async () => {
  const slow = (_input: Request | URL | string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    });
  const f = fetchWithTimeout(20, slow);
  const err = await assertRejects(() => f('http://x/'));
  assertEquals((err as DOMException).name, 'TimeoutError');
  const caller = new AbortController();
  const p = fetchWithTimeout(10_000, slow)('http://x/', { signal: caller.signal });
  caller.abort(new Error('caller gave up'));
  await assertRejects(() => p, Error, 'caller gave up');
});

Deno.test('runInBackground logs failures, never throws, and uses EdgeRuntime.waitUntil when present', async () => {
  const { log, lines } = captureLogger();
  await runInBackground(Promise.reject(new Error('job failed')), log);
  assertEquals(lines[0].entry.msg, 'background task failed');
  assertEquals(lines[0].entry.err_msg, 'job failed');

  const waited: Promise<unknown>[] = [];
  const g = globalThis as { EdgeRuntime?: unknown };
  g.EdgeRuntime = { waitUntil: (p: Promise<unknown>) => waited.push(p) };
  try {
    await runInBackground(Promise.resolve(1), log);
    assertEquals(waited.length, 1);
  } finally {
    delete g.EdgeRuntime;
  }
});
