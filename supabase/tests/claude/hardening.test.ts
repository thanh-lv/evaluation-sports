/**
 * Review hardening of the Claude module: the server-side fallback allowlist, billing across fallback attempts
 * (`usage.iterations`) and reading only the text after the last `fallback` block.
 */
import { assert, assertAlmostEquals, assertEquals } from '@std/assert';
import {
  billedCostUsd,
  buildCoachRequest,
  buildWarmRequest,
  costUsd,
  DEFAULT_MODEL_ROUTES,
  fakeMessage,
  FALLBACK_BETA,
  type ModelRoute,
  responseText,
  supportsServerFallback,
} from '@shared/claude/index.ts';
import { preparedFixture, requestInput } from './_claude.ts';

Deno.test('fallbacks: an allowlist of documented models; Haiku, Sonnet 5 and unknown ids get neither param nor beta', async () => {
  assert(supportsServerFallback('claude-sonnet-5-5'));
  assert(supportsServerFallback('claude-opus-5-5'));
  for (const m of ['claude-haiku-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-sonnet-5-5-x', 'gpt']) {
    assert(!supportsServerFallback(m), m);
  }
  const fx = await preparedFixture('synthetic_bd_clear_fh_60');
  // a misconfigured model_routes row: Sonnet 5 with fallbacks "default" and the beta listed
  const route: ModelRoute = { ...DEFAULT_MODEL_ROUTES.standard, model: 'claude-sonnet-5', betas: [FALLBACK_BETA] };
  const { params } = buildCoachRequest({ ...requestInput(fx, 'en'), route });
  assertEquals(params.fallbacks, undefined);
  assertEquals(params.betas, undefined);
  const warm = buildWarmRequest(route, 'badminton');
  assertEquals(warm.fallbacks, undefined);
  assertEquals(warm.betas, undefined);
});

Deno.test('responseText: only text after the last fallback block is parsed', () => {
  const msg = fakeMessage({ model: 'claude-sonnet-5', text: '{"ok":true}' });
  (msg.content as unknown[]).unshift(
    { type: 'text', text: '{"partial": ' },
    { type: 'fallback', from: { model: 'claude-sonnet-5-5' }, to: { model: 'claude-sonnet-5' } },
  );
  assertEquals(responseText(msg), '{"ok":true}');
  assertEquals(responseText(fakeMessage({ model: 'claude-sonnet-5-5', text: 'abc' })), 'abc');
});

Deno.test('billedCostUsd: sums every attempt in usage.iterations at its own model card', () => {
  const msg = fakeMessage({
    model: 'claude-sonnet-5',
    text: '{}',
    usage: { inputTokens: 1000, outputTokens: 2000 },
  });
  // without iterations: the top-level usage at the served model
  assertEquals(billedCostUsd(msg, 'claude-sonnet-5-5'), costUsd('claude-sonnet-5', msg_usage(1000, 2000)));
  Object.assign(msg.usage, {
    iterations: [
      {
        type: 'message',
        model: 'claude-sonnet-5-5',
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_creation: null,
      },
      {
        type: 'fallback_message',
        model: 'claude-sonnet-5',
        input_tokens: 1000,
        output_tokens: 2000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_creation: null,
      },
    ],
  });
  const expected = costUsd('claude-sonnet-5-5', msg_usage(1000, 500)) +
    costUsd('claude-sonnet-5', msg_usage(1000, 2000));
  assertAlmostEquals(billedCostUsd(msg, 'claude-sonnet-5-5'), expected, 1e-9);
  assert(billedCostUsd(msg, 'claude-sonnet-5-5') > costUsd('claude-sonnet-5', msg_usage(1000, 2000)));
});

function msg_usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheCreation1hInputTokens: 0,
  };
}
