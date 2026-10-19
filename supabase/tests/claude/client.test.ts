/** The SDK wrapper against a local stub of the Messages API (no network): wire format, no retries, timeout. */
import { assert, assertEquals, assertFalse } from '@std/assert';
import {
  anthropicCoachClient,
  buildCoachRequest,
  DEFAULT_MODEL_ROUTES,
  FALLBACK_BETA,
  mockCoachOutput,
  runOnce,
} from '@shared/claude/index.ts';
import { ppContext, preparedFixture, requestInput } from './_claude.ts';

interface Seen {
  path: string;
  beta: string | null;
  body: Record<string, unknown>;
}

async function withStub(
  respond: (n: number) => Response | Promise<Response>,
  fn: (baseURL: string, seen: Seen[]) => Promise<void>,
): Promise<void> {
  const seen: Seen[] = [];
  const ac = new AbortController();
  const server = Deno.serve({ port: 0, hostname: '127.0.0.1', signal: ac.signal, onListen: () => {} }, async (req) => {
    seen.push({ path: new URL(req.url).pathname, beta: req.headers.get('anthropic-beta'), body: await req.json() });
    return respond(seen.length);
  });
  try {
    await fn(`http://127.0.0.1:${server.addr.port}`, seen);
  } finally {
    ac.abort();
    await server.finished;
  }
}

function messageJson(text: string, model = 'claude-sonnet-5-5') {
  return {
    id: 'msg_stub',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 6000, output_tokens: 3000, cache_read_input_tokens: 8000, cache_creation_input_tokens: 0 },
  };
}

Deno.test('live client sends the §8.2 request on the beta endpoint and parses the response', async () => {
  const fx = await preparedFixture('synthetic_bd_clear_fh_60');
  const { params } = buildCoachRequest(requestInput(fx, 'vi'));
  const text = JSON.stringify(mockCoachOutput(ppContext(fx, 'vi')));
  await withStub(
    () => Response.json(messageJson(text), { headers: { 'request-id': 'req_123' } }),
    async (url, seen) => {
      const client = anthropicCoachClient({ apiKey: 'sk-ant-test', baseURL: url });
      const res = await runOnce(params, DEFAULT_MODEL_ROUTES.standard, { client });
      assertEquals(res.outcome.kind, 'ok');
      assertEquals(res.call.requestId, 'req_123');
      assertEquals(res.call.usage.cacheReadInputTokens, 8000);
      assertEquals(seen.length, 1);
      assertEquals(seen[0].path, '/v1/messages');
      assert(seen[0].beta?.includes(FALLBACK_BETA), `anthropic-beta: ${seen[0].beta}`);
      const body = seen[0].body;
      assertEquals(body.fallbacks, 'default');
      assertEquals((body.output_config as { effort: string }).effort, 'low');
      assertFalse('betas' in body, 'betas travel as a header');
      for (const k of ['temperature', 'top_p', 'top_k', 'thinking', 'tool_choice', 'stream']) {
        assertFalse(k in body && body[k] !== false, `${k} must not be sent`);
      }
    },
  );
});

Deno.test('live client never retries: one HTTP call on 529', async () => {
  const fx = await preparedFixture('synthetic_pb_dink_60');
  const { params } = buildCoachRequest(requestInput(fx, 'en', 'basic'));
  const overloaded = () =>
    Response.json({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, { status: 529 });
  await withStub(overloaded, async (url, seen) => {
    const client = anthropicCoachClient({ apiKey: 'sk-ant-test', baseURL: url });
    const res = await runOnce(params, DEFAULT_MODEL_ROUTES.basic, { client });
    assertEquals(res.outcome.kind, 'retryable');
    if (res.outcome.kind === 'retryable') assertEquals(res.outcome.status, 529);
    assertEquals(seen.length, 1);
    assertEquals(seen[0].beta, null, 'Haiku requests carry no fallback beta');
    assertFalse('fallbacks' in seen[0].body);
  });
});

Deno.test('live client: model_routes timeout aborts the call → retryable timeout', async () => {
  const fx = await preparedFixture('synthetic_pb_dink_60');
  const { params } = buildCoachRequest(requestInput(fx, 'en'));
  const slow = () => new Promise<Response>((resolve) => setTimeout(() => resolve(Response.json({})), 400));
  await withStub(slow, async (url) => {
    const client = anthropicCoachClient({ apiKey: 'sk-ant-test', baseURL: url });
    const res = await runOnce(params, { ...DEFAULT_MODEL_ROUTES.standard, timeoutMs: 50 }, { client });
    assertEquals(res.outcome.kind, 'retryable');
    if (res.outcome.kind === 'retryable') assertEquals(res.outcome.reason, 'timeout');
    // Let the stub's pending timer finish before the server shuts down.
    await new Promise((r) => setTimeout(r, 450));
  });
});
