/** Request layout (DESIGN.md §8.1 request rules, §8.2). */
import { assert, assertEquals, assertFalse } from '@std/assert';
import { APIError } from '@anthropic-ai/sdk';
import {
  buildCoachRequest,
  buildWarmRequest,
  DEFAULT_MODEL_ROUTES,
  FALLBACK_BETA,
  type ModelRoute,
  staticCoachClient,
  WARM_MAX_TOKENS,
  warmOnce,
} from '@shared/claude/index.ts';
import { assertSnapshot, preparedFixture, requestInput } from './_claude.ts';

type Block = { type: string; text?: string; source?: { type: string; media_type: string; data: string } };

const FORBIDDEN_KEYS = ['temperature', 'top_p', 'top_k', 'thinking', 'tool_choice', 'tools', 'stop_sequences'];

Deno.test('standard route: Sonnet 5.5 with effort low, server-side fallback and no forbidden parameters', async () => {
  const fx = await preparedFixture('synthetic_bd_clear_fh_60');
  const { params, sentFrameIds } = buildCoachRequest(requestInput(fx, 'vi'));
  assertEquals(params.model, 'claude-sonnet-5-5');
  assertEquals(params.max_tokens, 12000);
  assertEquals(params.output_config?.effort, 'low');
  assertEquals(params.output_config?.format?.type, 'json_schema');
  assertEquals(params.betas, [FALLBACK_BETA]);
  assertEquals(params.fallbacks, 'default');
  for (const k of FORBIDDEN_KEYS) assertFalse(k in params, `${k} must not be sent`);
  // One user turn, no prefill.
  assertEquals(params.messages.length, 1);
  assertEquals(params.messages[0].role, 'user');
  // F1..F5: a label text block before each base64 JPEG, then the user text.
  assertEquals(sentFrameIds, ['F1', 'F2', 'F3', 'F4', 'F5']);
  const content = params.messages[0].content as Block[];
  assertEquals(content.length, 11);
  for (let i = 0; i < 5; i++) {
    assertEquals(content[2 * i].type, 'text');
    assert(content[2 * i].text!.startsWith(`F${i + 1} · stroke `), content[2 * i].text);
    assertEquals(content[2 * i + 1].type, 'image');
    assertEquals(content[2 * i + 1].source?.media_type, 'image/jpeg');
    assertEquals(content[2 * i + 1].source?.type, 'base64');
  }
  const userText = content[10].text!;
  const tags = ['<session>', '<quality>', '<checkpoints>', '<strokes>', '<candidates>', '<visual_to_judge>'];
  let at = -1;
  for (const t of tags) {
    const i = userText.indexOf(t);
    assert(i > at, `${t} missing or out of order`);
    at = i;
  }
  assert(userText.endsWith('Output language: vi'));
});

Deno.test('basic route: Haiku 5.5 with effort medium and never any fallbacks', async () => {
  const fx = await preparedFixture('synthetic_pb_dink_60');
  const { params } = buildCoachRequest(requestInput(fx, 'en', 'basic'));
  assertEquals(params.model, 'claude-haiku-5-5');
  assertEquals(params.output_config?.effort, 'medium');
  assertFalse('fallbacks' in params);
  assertFalse('betas' in params);
  // Even a misconfigured route row cannot send fallbacks to Haiku.
  const bad: ModelRoute = { ...DEFAULT_MODEL_ROUTES.basic, fallbacks: 'default', betas: [FALLBACK_BETA, 'x-other'] };
  const p2 = buildCoachRequest({ ...requestInput(fx, 'en', 'basic'), route: bad }).params;
  assertFalse('fallbacks' in p2);
  assertEquals(p2.betas, ['x-other']);
});

Deno.test('max_tokens × max_tokens_mult on a retry', async () => {
  const fx = await preparedFixture('synthetic_bd_smash_30');
  assertEquals(buildCoachRequest({ ...requestInput(fx, 'vi'), maxTokensMult: 1.5 }).params.max_tokens, 18000);
  assertEquals(buildCoachRequest({ ...requestInput(fx, 'vi'), maxTokensMult: 0 }).params.max_tokens, 12000);
});

Deno.test('pose_only: no images, visual items answered with -1', async () => {
  const fx = await preparedFixture('synthetic_bd_clear_fh_60', 'pose_only');
  const { params, sentFrameIds } = buildCoachRequest(requestInput(fx, 'en'));
  assertEquals(sentFrameIds, []);
  const content = params.messages[0].content as Block[];
  assertEquals(content.length, 1);
  assertEquals(content[0].type, 'text');
  assert(content[0].text!.includes('frame_mode: pose_only (no frames are sent)'));
  assert(content[0].text!.includes('No frames were sent: answer level -1'));
});

Deno.test('frames missing from Storage are skipped and not cited', async () => {
  const fx = await preparedFixture('synthetic_bd_clear_fh_60');
  const input = requestInput(fx, 'vi');
  const { sentFrameIds, params } = buildCoachRequest({
    ...input,
    frames: input.frames.filter((f) => f.frameId !== 'F2'),
  });
  assertEquals(sentFrameIds, ['F1', 'F3', 'F4', 'F5']);
  const text = (params.messages[0].content as Block[]).at(-1)!.text!;
  assertFalse(/\| F2\b/.test(text.slice(text.indexOf('<visual_to_judge>'))), 'F2 must not be offered for judging');
});

Deno.test('request snapshot (image data elided)', async () => {
  const fx = await preparedFixture('synthetic_pb_dink_60');
  const { params } = buildCoachRequest(requestInput(fx, 'en'));
  const json = JSON.stringify(
    params,
    (k, v) => {
      if (k === 'data') return `<${String(v).length} b64>`;
      if (k === 'schema') return '<coach.v1 pickleball schema>';
      if (k === 'system') return (v as { text: string }[]).map((b) => ({ ...b, text: `<${b.text.length} chars>` }));
      return v;
    },
    2,
  );
  await assertSnapshot('request.pb_dink_60.en.json', json + '\n');
});

Deno.test('warm-up request shares the real request prefix (system, effort, schema) and tolerates max_tokens', async () => {
  const fx = await preparedFixture('synthetic_bd_clear_fh_60');
  for (const kind of ['basic', 'standard'] as const) {
    const real = buildCoachRequest(requestInput(fx, 'vi', kind)).params;
    const warm = buildWarmRequest(DEFAULT_MODEL_ROUTES[kind], 'badminton');
    assertEquals(JSON.stringify(warm.system), JSON.stringify(real.system));
    assertEquals(JSON.stringify(warm.output_config), JSON.stringify(real.output_config));
    assertEquals(warm.fallbacks, real.fallbacks);
    assertEquals(warm.max_tokens, WARM_MAX_TOKENS);
    const w = await warmOnce(DEFAULT_MODEL_ROUTES[kind], 'badminton', {
      client: staticCoachClient(() => ({}), 'max_tokens'),
    });
    assert(w.ok);
    const bad = await warmOnce(DEFAULT_MODEL_ROUTES[kind], 'badminton', {
      client: {
        name: 'test',
        create: () =>
          Promise.reject(
            APIError.generate(
              400,
              { type: 'error', error: { type: 'invalid_request_error', message: 'Schema is too complex' } },
              'Schema is too complex',
              new Headers(),
            ),
          ),
      },
    });
    assertFalse(bad.ok);
    assertEquals(bad.run.outcome.kind, 'bad_request');
  }
});
