/** runOnce outcome classification (DESIGN.md §8.3), usage and cost. */
import { assert, assertAlmostEquals, assertEquals } from '@std/assert';
import { APIConnectionError, APIConnectionTimeoutError, APIError } from '@anthropic-ai/sdk';
import {
  buildCoachRequest,
  classifyError,
  type CoachMessage,
  type CoachModelClient,
  costUsd,
  DEFAULT_MODEL_ROUTES,
  fakeMessage,
  mockCoachOutput,
  runOnce,
  staticCoachClient,
} from '@shared/claude/index.ts';
import { captureLogger } from '@shared/testing/log.ts';
import { ppContext, preparedFixture, requestInput } from './_claude.ts';

const route = DEFAULT_MODEL_ROUTES.standard;

async function params() {
  const fx = await preparedFixture('synthetic_bd_clear_fh_60');
  return buildCoachRequest(requestInput(fx, 'vi')).params;
}

function clientOf(fn: () => Promise<CoachMessage>): CoachModelClient {
  return { name: 'test', create: () => fn() };
}

function apiError(status: number, type = 'api_error'): APIError {
  return APIError.generate(status, { type: 'error', error: { type, message: type } }, type, new Headers());
}

Deno.test('ok: text block parsed (thinking blocks skipped), usage, cost and cache reads logged', async () => {
  const fx = await preparedFixture('synthetic_bd_clear_fh_60');
  const out = mockCoachOutput(ppContext(fx, 'vi'));
  const { log, lines } = captureLogger();
  const msg = fakeMessage({
    model: 'claude-sonnet-5-5',
    text: JSON.stringify(out),
    withThinking: true,
    usage: { inputTokens: 6400, outputTokens: 3300, cacheReadInputTokens: 8000, cacheCreationInputTokens: 0 },
  });
  let t = 1000;
  const res = await runOnce(await params(), route, {
    client: clientOf(() => Promise.resolve(msg)),
    log,
    now: () => (t += 250),
  });
  assertEquals(res.outcome.kind, 'ok');
  if (res.outcome.kind === 'ok') assertEquals(res.outcome.output.summary, out.summary);
  assertEquals(res.call.modelServed, 'claude-sonnet-5-5');
  assertEquals(res.call.latencyMs, 250);
  assertEquals(res.call.usage.cacheReadInputTokens, 8000);
  // 6400×2 + 3300×10 + 8000×0.20 per MTok
  assertAlmostEquals(res.call.costUsd, (6400 * 2 + 3300 * 10 + 8000 * 0.2) / 1e6, 1e-9);
  assertEquals(res.call.error, null);
  const line = lines.find((l) => l.entry.msg === 'claude_call');
  assert(line, 'claude_call logged');
  assertEquals((line.entry.usage as { cacheReadInputTokens: number }).cacheReadInputTokens, 8000);
  assertEquals(line.entry.outcome, 'ok');
});

Deno.test('refusal: category and served model recorded, before reading content', async () => {
  for (const category of ['cyber', 'general_harms', null] as const) {
    const res = await runOnce(await params(), route, {
      client: clientOf(() =>
        Promise.resolve(fakeMessage({ model: 'claude-sonnet-5-5', stopReason: 'refusal', refusalCategory: category }))
      ),
    });
    assertEquals(res.outcome.kind, 'refusal');
    if (res.outcome.kind === 'refusal') assertEquals(res.outcome.category, category);
    assertEquals(res.call.refusalCategory, category);
    assertEquals(res.call.stopReason, 'refusal');
  }
  // A refusal that still carries partial text is a refusal, not a parse error.
  const partial = fakeMessage({ model: 'claude-sonnet-5-5', stopReason: 'refusal', text: '{"schema_version":' });
  assertEquals(
    (await runOnce(await params(), route, { client: clientOf(() => Promise.resolve(partial)) })).outcome.kind,
    'refusal',
  );
});

Deno.test('server-side fallback: model_served is the fallback model and priced at its card', async () => {
  const fx = await preparedFixture('synthetic_bd_clear_fh_60');
  const msg = fakeMessage({
    model: 'claude-sonnet-5',
    text: JSON.stringify(mockCoachOutput(ppContext(fx, 'en'))),
    usage: { inputTokens: 1000, outputTokens: 1000 },
  });
  (msg.content as unknown[]).unshift({
    type: 'fallback',
    from: { model: 'claude-sonnet-5-5' },
    to: { model: 'claude-sonnet-5' },
  });
  const res = await runOnce(await params(), route, { client: clientOf(() => Promise.resolve(msg)) });
  assertEquals(res.outcome.kind, 'ok');
  assertEquals(res.call.modelRequested, 'claude-sonnet-5-5');
  assertEquals(res.call.modelServed, 'claude-sonnet-5');
  assertEquals(res.call.fallbackUsed, true);
});

Deno.test('max_tokens, invalid JSON and schema failures', async () => {
  const p = await params();
  const mt = await runOnce(p, route, { client: staticCoachClient(() => ({}), 'max_tokens') });
  assertEquals(mt.outcome.kind, 'max_tokens');
  const bad = await runOnce(p, route, { client: staticCoachClient(() => ({}), 'invalid_json') });
  assertEquals(bad.outcome.kind, 'parse_error');
  const zod = await runOnce(p, route, { client: staticCoachClient(() => ({ schema_version: 'coach.v1' })) });
  assertEquals(zod.outcome.kind, 'parse_error');
  if (zod.outcome.kind === 'parse_error') assert(zod.outcome.error.startsWith('schema:'), zod.outcome.error);
  const empty = await runOnce(p, route, {
    client: clientOf(() => Promise.resolve(fakeMessage({ model: 'claude-sonnet-5-5', withThinking: true }))),
  });
  assertEquals(empty.outcome.kind, 'parse_error');
});

Deno.test('529 / 429 / 5xx / timeout / network are retryable; 400 is bad_request', async () => {
  const p = await params();
  const overloaded = await runOnce(p, route, { client: staticCoachClient(() => ({}), 'overloaded') });
  assertEquals(overloaded.outcome.kind, 'retryable');
  if (overloaded.outcome.kind === 'retryable') {
    assertEquals(overloaded.outcome.reason, 'overloaded');
    assertEquals(overloaded.outcome.status, 529);
  }
  assertEquals(overloaded.call.usage.inputTokens, 0);
  assertEquals(overloaded.call.costUsd, 0);
  assertEquals(overloaded.call.modelServed, null);

  const cases: [unknown, string, string][] = [
    [apiError(429, 'rate_limit_error'), 'retryable', 'rate_limited'],
    [apiError(500), 'retryable', 'server_error'],
    [apiError(503), 'retryable', 'server_error'],
    [apiError(408), 'retryable', 'timeout'],
    [new APIConnectionTimeoutError(), 'retryable', 'timeout'],
    [new APIConnectionError({ message: 'reset' }), 'retryable', 'network'],
    [new DOMException('signal timed out', 'TimeoutError'), 'retryable', 'timeout'],
    [new TypeError('fetch failed'), 'retryable', 'network'],
    [apiError(400, 'invalid_request_error'), 'bad_request', ''],
    [apiError(413, 'request_too_large'), 'bad_request', ''],
  ];
  for (const [err, kind, reason] of cases) {
    const o = classifyError(err);
    assertEquals(o.kind, kind, String(err));
    if (o.kind === 'retryable') assertEquals(o.reason, reason, String(err));
    const res = await runOnce(p, route, { client: clientOf(() => Promise.reject(err)) });
    assertEquals(res.outcome.kind, kind);
    assert(res.call.error, 'error text recorded');
  }
});

Deno.test('price table: Haiku and Sonnet cards, cache writes, long-context Haiku', () => {
  const u = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheCreation1hInputTokens: 0,
  };
  assertAlmostEquals(costUsd('claude-haiku-5-5', { ...u, inputTokens: 50_000, outputTokens: 0 }), 0.005, 1e-9);
  assertAlmostEquals(costUsd('claude-sonnet-5-5', u), 12, 1e-9);
  const reads = { ...u, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 1_000_000 };
  assertAlmostEquals(costUsd('claude-haiku-5-5', reads), 0.05, 1e-9); // > 100K prompt → long-context card
  assertAlmostEquals(costUsd('claude-sonnet-5-5', reads), 0.2, 1e-9);
  const writes = { ...u, inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 80_000 };
  assertAlmostEquals(costUsd('claude-haiku-5-5', writes), 0.01, 1e-9); // 80K × $0.125
  assertAlmostEquals(costUsd('claude-sonnet-5-5', writes), 0.2, 1e-9); // 80K × $2.50
  // DESIGN §8.7 warm-cache Sonnet estimate: 6.4K in, 7K cached, 3.3K out ≈ $0.047.
  const warm = {
    inputTokens: 6400,
    outputTokens: 3300,
    cacheReadInputTokens: 7000,
    cacheCreationInputTokens: 0,
    cacheCreation1hInputTokens: 0,
  };
  assertAlmostEquals(costUsd('claude-sonnet-5-5', warm), 0.0475, 0.001);
});
