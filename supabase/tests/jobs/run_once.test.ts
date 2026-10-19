/**
 * `runOnce` (DESIGN.md D12, §8.3) against the in-memory job backend: one model call per invocation, fencing, the
 * stale re-claim after 8 minutes, results-exist → finalize only, requeue/backoff and the retry ceiling, refunds,
 * llm_calls / spend / llm_outputs accounting and frame deletion.
 */
import { assert, assertEquals } from '@std/assert';
import { APIError } from '@anthropic-ai/sdk';
import { CoachResultV1 } from '@shared/contracts/index.ts';
import type { CoachModelClient } from '@shared/claude/index.ts';
import { JOB_LIMITS, runOnce } from '@shared/jobs/index.ts';
import { framesLeft, jobFixture, UID } from './_jobs.ts';

const MIN = 60_000;

Deno.test('runOnce: ok → finalized, quota committed, frames deleted, call + cost + output recorded', async () => {
  const f = await jobFixture();
  assertEquals(framesLeft(f.backend, f.id).length, 5);
  const r = await runOnce(f.id, f.deps);
  assertEquals(r, { status: 'finalized', attempt: 1, resultStatus: 'succeeded', fromStored: false });
  assertEquals(f.client.calls.length, 1);
  assertEquals(f.client.calls[0].model, 'claude-sonnet-5-5', 'standard kind → Sonnet route');
  const images = (f.client.calls[0].messages[0].content as { type: string }[]).filter((b) => b.type === 'image');
  assertEquals(images.length, 5, 'the five frames are sent as base64 images');

  const row = f.backend.analysis(f.id)!;
  assertEquals(row.status, 'succeeded');
  const stored = f.backend.result(f.id)!;
  const parsed = CoachResultV1.safeParse(stored.result);
  assert(parsed.success, JSON.stringify(parsed.error?.issues.slice(0, 3)));
  assertEquals(parsed.data.access, 'full');
  assertEquals(f.backend.ledger.get(f.id)!.state, 'committed');
  assertEquals(framesLeft(f.backend, f.id), []);

  const calls = f.backend.db.table('private', 'llm_calls');
  assertEquals(calls.length, 1);
  assertEquals(calls[0].attempt, 1);
  assertEquals(calls[0].kind, 'standard');
  assertEquals(calls[0].error, null);
  assert(Number(calls[0].cost_usd) > 0);
  assert(f.backend.budget.spentUsd > 0, 'cost added to daily_spend');
  assertEquals(f.backend.db.table('private', 'user_monthly_cost')[0].user_id, UID);
  assertEquals(f.backend.db.table('private', 'llm_outputs').length, 1);
  assertEquals(f.inflight.size, 0);
});

Deno.test('runOnce: pose_only sends no images and keeps working without frames', async () => {
  const f = await jobFixture({ frameMode: 'pose_only', frames: false, row: { kind: 'basic' } });
  const r = await runOnce(f.id, f.deps);
  assertEquals(r.status, 'finalized');
  const content = f.client.calls[0].messages[0].content as { type: string }[];
  assertEquals(content.filter((b) => b.type === 'image').length, 0);
  assertEquals(f.client.calls[0].model, 'claude-haiku-5-5');
});

Deno.test('runOnce: one model attempt per invocation; retryable → requeue with 30 s·2^attempt backoff', async () => {
  const f = await jobFixture({ scenarios: ['overloaded', 'overloaded', 'overloaded'] });
  const r1 = await runOnce(f.id, f.deps);
  assertEquals(r1, { status: 'requeued', attempt: 1, code: 'retry_overloaded', delayS: 60 });
  assertEquals(f.client.calls.length, 1);
  assertEquals(f.backend.analysis(f.id)!.status, 'queued');

  assertEquals(await runOnce(f.id, f.deps), { status: 'not_claimed' }, 'not due during the backoff');
  assertEquals(f.client.calls.length, 1);

  f.backend.advance(61_000);
  assertEquals(await runOnce(f.id, f.deps), { status: 'requeued', attempt: 2, code: 'retry_overloaded', delayS: 120 });
  f.backend.advance(121_000);
  const r3 = await runOnce(f.id, f.deps);
  assertEquals(r3, { status: 'failed', attempt: JOB_LIMITS.maxAttempts, code: 'upstream_unavailable' });
  assertEquals(f.client.calls.length, 3, 'exactly one call per invocation');
  assertEquals(f.backend.ledger.get(f.id)!.state, 'refunded');
  assertEquals(f.backend.users.get(UID)!.used, 0, 'quota given back');
  assertEquals(framesLeft(f.backend, f.id).length, 5, 'failed jobs keep frames until the 72 h sweep');
  assertEquals(f.backend.db.table('private', 'llm_calls').length, 3, 'every attempt is logged');
});

Deno.test('runOnce: max_tokens → requeue with max_tokens_mult 1.5 (bigger request), then bad_output', async () => {
  const f = await jobFixture({ scenarios: ['max_tokens', 'max_tokens'] });
  assertEquals(await runOnce(f.id, f.deps), { status: 'requeued', attempt: 1, code: 'max_tokens', delayS: 0 });
  assertEquals(f.backend.analysis(f.id)!.max_tokens_mult, 1.5);
  assertEquals(await runOnce(f.id, f.deps), { status: 'failed', attempt: 2, code: 'bad_output' });
  assertEquals(f.client.calls[1].max_tokens, Math.round(f.client.calls[0].max_tokens * 1.5));
  assertEquals(f.backend.ledger.get(f.id)!.state, 'refunded');
});

Deno.test('runOnce: a parse error is requeued once; the second fails bad_output', async () => {
  const f = await jobFixture({ scenarios: ['invalid_json', 'invalid_json'] });
  assertEquals((await runOnce(f.id, f.deps)).status, 'requeued');
  const calls = f.backend.db.table('private', 'llm_calls');
  assert(String(calls[0].error).startsWith('parse_error'), String(calls[0].error));
  assertEquals(f.backend.db.table('private', 'llm_outputs').length, 1, 'the unparsable text is kept for debugging');
  assertEquals(await runOnce(f.id, f.deps), { status: 'failed', attempt: 2, code: 'bad_output' });
});

Deno.test('runOnce: a parse error after a different failure still gets its one retry', async () => {
  const f = await jobFixture({ scenarios: ['max_tokens', 'invalid_json', 'ok'] });
  assertEquals((await runOnce(f.id, f.deps)).status, 'requeued');
  assertEquals((await runOnce(f.id, f.deps)).status, 'requeued');
  assertEquals((await runOnce(f.id, f.deps)).status, 'finalized');
});

Deno.test('runOnce: refusal → fail model_refusal with a full refund', async () => {
  const f = await jobFixture({ scenarios: ['refusal'] });
  assertEquals(await runOnce(f.id, f.deps), { status: 'failed', attempt: 1, code: 'model_refusal' });
  assertEquals(f.backend.ledger.get(f.id)!.reason, 'model_refusal');
  assertEquals(f.backend.db.table('private', 'llm_calls')[0].refusal_category, 'general_harms');
});

Deno.test('runOnce: 400 → fail bad_request with an operator alert', async () => {
  const f = await jobFixture();
  f.deps.coachClient = (): CoachModelClient => ({
    name: 'bad',
    create: () =>
      Promise.reject(
        new APIError(
          400,
          { type: 'error', error: { type: 'invalid_request_error', message: 'Schema is too complex' } },
          'Schema is too complex',
          new Headers(),
        ),
      ),
  });
  assertEquals(await runOnce(f.id, f.deps), { status: 'failed', attempt: 1, code: 'bad_request' });
  assert(f.lines.some((l) => l.level === 'error' && l.entry.alert === true));
  assertEquals(f.backend.db.table('public', 'events')[0].name, 'ops.job_failed');
});

Deno.test('runOnce: a job locked by a live worker is not claimed; after 8 minutes it is re-claimed', async () => {
  const f = await jobFixture();
  const row = f.backend.analysis(f.id)!;
  Object.assign(row, { status: 'processing', attempt_count: 1, locked_at: f.backend.now().toISOString() });
  f.backend.advance(7 * MIN);
  assertEquals(await runOnce(f.id, f.deps), { status: 'not_claimed' });
  assertEquals(f.client.calls.length, 0);
  f.backend.advance(2 * MIN);
  const r = await runOnce(f.id, f.deps);
  assertEquals(r.status, 'finalized');
  assertEquals((r as { attempt: number }).attempt, 2);
});

Deno.test('runOnce: fence lost during the call → output discarded, cost still logged', async () => {
  const f = await jobFixture();
  // Another worker re-claims the job while the model call is in flight.
  f.client.onCall = () => {
    const row = f.backend.analysis(f.id)!;
    row.attempt_count = (row.attempt_count as number) + 1;
  };
  const r = await runOnce(f.id, f.deps);
  assertEquals(r, { status: 'fence_lost', attempt: 1, action: 'finalize' });
  assertEquals(f.backend.result(f.id), undefined);
  assertEquals(f.backend.db.table('private', 'llm_calls').length, 1);
  assert(f.backend.budget.spentUsd > 0);
  assertEquals(f.backend.ledger.get(f.id)!.state, 'reserved', 'the owner of the fence settles the quota');
});

Deno.test('runOnce: results already stored → finalize only, no model call', async () => {
  const first = await jobFixture();
  await runOnce(first.id, first.deps);
  const stored = first.backend.result(first.id)!.result;

  const f = await jobFixture();
  f.backend.db.table('public', 'analysis_results').push({ analysis_id: f.id, result: stored, overall_score: 61.2 });
  const r = await runOnce(f.id, f.deps);
  assertEquals(r, { status: 'finalized', attempt: 1, resultStatus: 'succeeded', fromStored: true });
  assertEquals(f.client.calls.length, 0);
  assertEquals(f.backend.analysis(f.id)!.status, 'succeeded');
  assertEquals(f.backend.ledger.get(f.id)!.state, 'committed');
  assertEquals(framesLeft(f.backend, f.id), []);
});

Deno.test('runOnce: terminal and unknown jobs are not claimed', async () => {
  const f = await jobFixture({ row: { status: 'succeeded' } });
  assertEquals(await runOnce(f.id, f.deps), { status: 'terminal', state: 'succeeded' });
  assertEquals(framesLeft(f.backend, f.id), [], 'leftover frames of a finished job are removed');
  assertEquals(await runOnce(crypto.randomUUID(), f.deps), { status: 'not_found' });
  assertEquals(f.client.calls.length, 0);
});

Deno.test('runOnce: past the hard attempt cap the job fails without calling the model', async () => {
  const f = await jobFixture({ row: { attempt_count: JOB_LIMITS.hardMaxAttempts } });
  assertEquals(await runOnce(f.id, f.deps), {
    status: 'failed',
    attempt: JOB_LIMITS.hardMaxAttempts + 1,
    code: 'internal',
  });
  assertEquals(f.client.calls.length, 0);
});

Deno.test('runOnce: missing frames fail the job (refund); a DB error requeues with backoff', async () => {
  const f = await jobFixture({ frames: false });
  assertEquals(await runOnce(f.id, f.deps), { status: 'failed', attempt: 1, code: 'internal' });
  assertEquals(f.backend.ledger.get(f.id)!.state, 'refunded');

  const g = await jobFixture();
  const original = g.backend.db.selectOne.bind(g.backend.db);
  g.backend.db.selectOne = (schema, table, columns, match) =>
    table === 'model_routes' ? Promise.reject(new Error('db down')) : original(schema, table, columns, match);
  assertEquals(await runOnce(g.id, g.deps), { status: 'requeued', attempt: 1, code: 'internal_error', delayS: 60 });
  assertEquals(g.client.calls.length, 0);
});

Deno.test('runOnce: the in-flight registry requeues running jobs on shutdown (fenced)', async () => {
  const f = await jobFixture();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const original = f.deps.coachClient;
  f.deps.coachClient = (src) => {
    const inner = original(src);
    return { name: 'slow', create: async (p, o) => (await gate, inner.create(p, o)) };
  };
  const running = runOnce(f.id, f.deps);
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(f.inflight.size, 1);
  assertEquals(await f.inflight.requeueAll(f.backend.db, f.deps.log), 1);
  assertEquals(f.backend.analysis(f.id)!.status, 'queued');
  release();
  assertEquals((await running).status, 'fence_lost', 'the requeued attempt can no longer finalize');
  assertEquals(f.inflight.size, 0);
});

Deno.test('runOnce: the 70 % daily budget alert fires once', async () => {
  const f = await jobFixture();
  f.backend.budget.budgetUsd = 0.01; // any call crosses 70 %
  await runOnce(f.id, f.deps);
  const alerts = f.lines.filter((l) => l.entry.msg === 'alert: spend_alert');
  assertEquals(alerts.length, 1);
  assertEquals(f.backend.db.table('private', 'daily_spend')[0].alerted_70, true);
});
