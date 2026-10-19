/**
 * POST /analyze/submit, /analyze/run and /cron (DESIGN.md §6.1, §8.7, D12, D18) with fakes: ownership, consents,
 * frames, the budget guard (503 without reserving), DeviceCheck bonus, 402/429 from reserve_for_submit without a
 * reservation, idempotency, the background job, and the shared-secret routes.
 */
import { assert, assertEquals } from '@std/assert';
import { SubmitResponse } from '@shared/contracts/index.ts';
import { BUCKET_INPUTS, framePath } from '@shared/storage.ts';
import { assertApiError, jsonRequest, readJsonResponse } from '@shared/testing/index.ts';
import { createCronHandler } from '../../functions/cron/handler.ts';
import { JPEG } from '../jobs/_jobs.ts';
import { ALICE, BOB, INTERNAL, poseBody, type Rig, rig } from './_analyze.ts';

async function prepared(r: Rig, uid = ALICE, options: { frames?: number; minor?: boolean } = {}): Promise<string> {
  const pose = await poseBody(options.minor ? 'synthetic_pb_dink_60' : 'synthetic_bd_clear_fh_60', {
    subjectMinor: options.minor,
  });
  const res = await r.post('/prepare', pose, uid);
  assertEquals(res.status, 200);
  await res.body?.cancel();
  const ids = ['F1', 'F2', 'F3', 'F4', 'F5'].slice(0, options.minor ? 0 : options.frames ?? 5);
  for (const f of ids) r.b.memory.put(BUCKET_INPUTS, framePath(uid, pose.analysisId, f), JPEG, 'image/jpeg');
  return pose.analysisId;
}

const reserveCalls = (r: Rig) => r.b.db.callsTo('rpc', 'private.reserve_for_submit');

Deno.test('submit: 202 queued, the job runs in the background to succeeded, frames removed', async () => {
  const r = rig();
  const id = await prepared(r);
  const res = await r.post('/submit', { analysisId: id });
  assertEquals(res.status, 202);
  assertEquals(SubmitResponse.parse(await readJsonResponse(res)), { status: 'queued', pollAfterMs: 2000 });
  await r.drain();
  assertEquals(r.b.analysis(id)!.status, 'succeeded');
  assert(r.b.result(id));
  assertEquals(r.b.memory.paths(BUCKET_INPUTS).filter((p) => p.includes(id)), []);
  assertEquals(r.client.calls.length, 1);
});

Deno.test('submit: idempotent — queued/processing → 202 without a new reservation, succeeded → 200', async () => {
  const r = rig();
  r.client.scenarios = ['overloaded']; // first attempt requeues: the job stays queued
  const id = await prepared(r);
  assertEquals((await r.post('/submit', { analysisId: id })).status, 202);
  await r.drain();
  assertEquals(r.b.analysis(id)!.status, 'queued');
  const again = await r.post('/submit', { analysisId: id });
  assertEquals(again.status, 202);
  assertEquals((await readJsonResponse<SubmitResponse>(again)).status, 'queued');
  assertEquals(reserveCalls(r).length, 1);
  assertEquals(r.b.users.get(ALICE)!.used, 1);
  r.b.advance(61_000);
  await r.drain();
  // the re-submit kicked the job again; after the backoff a further kick finishes it
  assertEquals((await r.post('/submit', { analysisId: id })).status, 202);
  await r.drain();
  assertEquals(r.b.analysis(id)!.status, 'succeeded');
  const done = await r.post('/submit', { analysisId: id });
  assertEquals(done.status, 200);
  assertEquals(await readJsonResponse(done), { status: 'succeeded', pollAfterMs: 0 });
  assertEquals(reserveCalls(r).length, 1);
});

Deno.test('submit: 404 for an unknown or foreign analysis, 409 for a rejected draft', async () => {
  const r = rig();
  const id = await prepared(r);
  await assertApiError(await r.post('/submit', { analysisId: crypto.randomUUID() }), 'analysis_not_found');
  await assertApiError(await r.post('/submit', { analysisId: id }, BOB), 'analysis_not_found');
  await assertApiError(await r.post('/submit', { analysisId: 'NOT-A-UUID' }), 'invalid_payload');
  r.b.analysis(id)!.status = 'rejected';
  await assertApiError(await r.post('/submit', { analysisId: id }), 'analysis_conflict');
  assertEquals(reserveCalls(r).length, 0);
});

Deno.test('submit: 403 consent_required and 422 frames_missing come before any reservation', async () => {
  const r = rig();
  const id = await prepared(r, ALICE, { frames: 4 });
  r.b.users.get(ALICE)!.consent = false;
  await assertApiError(await r.post('/submit', { analysisId: id }), 'consent_required');
  r.b.users.get(ALICE)!.consent = true;
  const body = await assertApiError(await r.post('/submit', { analysisId: id }), 'frames_missing');
  assertEquals(body.message, 'missing F5');
  assertEquals(reserveCalls(r).length, 0);
  assertEquals(r.b.analysis(id)!.status, 'prepared');
});

Deno.test('submit: pose_only needs no frames', async () => {
  const r = rig();
  const id = await prepared(r, ALICE, { minor: true });
  assertEquals((await r.post('/submit', { analysisId: id })).status, 202);
  await r.drain();
  assertEquals(r.b.analysis(id)!.status, 'succeeded');
});

Deno.test('submit: free quota — 2nd analysis consumes it, 3rd → 402 without a reservation', async () => {
  const r = rig();
  for (let i = 0; i < 2; i++) {
    const id = await prepared(r);
    assertEquals((await r.post('/submit', { analysisId: id })).status, 202);
    await r.drain();
    assertEquals(r.b.analysis(id)!.status, 'succeeded');
  }
  const third = await prepared(r);
  const body = await assertApiError(await r.post('/submit', { analysisId: third }), 'quota_exceeded');
  assertEquals([body.limit, body.used], [2, 2]);
  assertEquals(r.b.analysis(third)!.status, 'prepared');
  assertEquals(r.b.ledger.has(third), false);
});

Deno.test('submit: 429 in_flight while another analysis is queued', async () => {
  const r = rig();
  r.client.scenarios = ['overloaded'];
  const a = await prepared(r);
  const b = await prepared(r);
  assertEquals((await r.post('/submit', { analysisId: a })).status, 202);
  await r.drain();
  const body = await assertApiError(await r.post('/submit', { analysisId: b }), 'in_flight');
  assertEquals(body.limit, 1);
  assertEquals(r.b.ledger.has(b), false);
});

Deno.test('submit: budget guard — free users get 503 at 100 % with nothing reserved', async () => {
  const r = rig();
  const id = await prepared(r);
  r.b.budget.spentUsd = 30;
  const res = await r.post('/submit', { analysisId: id });
  await assertApiError(res, 'busy_try_later');
  assert(Number(res.headers.get('retry-after')) > 0);
  assertEquals(reserveCalls(r).length, 0);
  assertEquals(r.b.users.get(ALICE)!.used, 0);
  assertEquals(r.b.analysis(id)!.status, 'prepared');
});

Deno.test('submit: budget guard — premium, trial and reviewers are served at 100 %, refused at 2×', async () => {
  for (const patch of [{ tier: 'premium' as const }, { tier: 'trial' as const }, { isReviewer: true }]) {
    const r = rig();
    Object.assign(r.b.users.get(ALICE)!, patch);
    r.b.db.table('public', 'profiles').find((p) => p.id === ALICE)!.is_reviewer = patch.isReviewer === true;
    r.b.budget.spentUsd = 45;
    assertEquals((await r.post('/submit', { analysisId: await prepared(r) })).status, 202, JSON.stringify(patch));
    await r.drain();
    r.b.budget.spentUsd = 60;
    await assertApiError(await r.post('/submit', { analysisId: await prepared(r) }), 'busy_try_later');
  }
});

Deno.test('submit: DeviceCheck — an unused device gets the free first-ever standard analysis', async () => {
  const r = rig();
  const id = await prepared(r);
  assertEquals((await r.post('/submit', { analysisId: id, deviceCheckToken: 'dc-token' })).status, 202);
  await r.drain();
  assertEquals(r.deviceCheck.queries, ['dc-token']);
  assertEquals(reserveCalls(r)[0].args, { p_user_id: ALICE, p_analysis_id: id, p_device_bonus_ok: true });
  assertEquals(r.b.analysis(id)!.kind, 'standard');
  assertEquals(r.client.calls[0].model, 'claude-sonnet-5-5');
  assertEquals(r.deviceCheck.updates, [{ token: 'dc-token', bit0: true, bit1: false }]);
});

Deno.test('submit: DeviceCheck — used device, failure, no token or no client → basic', async () => {
  const cases: [string, (r: Rig) => void, string | undefined][] = [
    ['bit0 set', (r) => (r.deviceCheck.bits = { bit0: true, bit1: false, lastUpdateTime: '2026-09' }), 'tok'],
    ['query fails', (r) => (r.deviceCheck.fail = new Error('apple down')), 'tok'],
    ['no token', () => {}, undefined],
  ];
  for (const [name, arrange, token] of cases) {
    const r = rig();
    arrange(r);
    const id = await prepared(r);
    assertEquals((await r.post('/submit', { analysisId: id, deviceCheckToken: token })).status, 202, name);
    await r.drain();
    assertEquals(r.b.analysis(id)!.kind, 'basic', name);
    assertEquals(r.deviceCheck.updates, [], name);
  }
  const r = rig({ deviceCheck: false });
  const id = await prepared(r);
  assertEquals((await r.post('/submit', { analysisId: id, deviceCheckToken: 'tok' })).status, 202);
  await r.drain();
  assertEquals(r.b.analysis(id)!.kind, 'basic');
});

Deno.test('submit: at 70 % of the budget free standard is downgraded (DeviceCheck not even asked)', async () => {
  const r = rig();
  r.b.budget.spentUsd = 22;
  const id = await prepared(r);
  assertEquals((await r.post('/submit', { analysisId: id, deviceCheckToken: 'tok' })).status, 202);
  await r.drain();
  assertEquals(r.deviceCheck.queries, []);
  assertEquals(reserveCalls(r)[0].args, { p_user_id: ALICE, p_analysis_id: id, p_device_bonus_ok: false });
  assertEquals(r.b.analysis(id)!.kind, 'basic');
});

Deno.test('run: x-internal-secret required; 202 and the job runs once', async () => {
  const r = rig();
  const id = await prepared(r);
  r.client.scenarios = ['overloaded'];
  await r.post('/submit', { analysisId: id });
  await r.drain();
  assertEquals(r.b.analysis(id)!.status, 'queued');

  await assertApiError(await r.post('/run', { analysisId: id }, null), 'unauthorized');
  await assertApiError(await r.post('/run', { analysisId: id }, null, { 'x-internal-secret': 'nope' }), 'unauthorized');
  await assertApiError(await r.post('/run', { nope: 1 }, null, { 'x-internal-secret': INTERNAL }), 'invalid_payload');

  r.b.advance(61_000);
  const res = await r.post('/run', { analysisId: id }, null, { 'x-internal-secret': INTERNAL });
  assertEquals(res.status, 202);
  assertEquals(await readJsonResponse(res), { accepted: true });
  await r.drain();
  assertEquals(r.b.analysis(id)!.status, 'succeeded');
  // duplicate deliveries are harmless
  await (await r.post('/run', { analysisId: id }, null, { 'x-internal-secret': INTERNAL })).body?.cancel();
  await r.drain();
  assertEquals(r.client.calls.length, 2);
});

Deno.test('cron: x-cron-secret required; unknown task 422; daily answers 202 and runs in the background', async () => {
  const r = rig();
  const tasks: Promise<unknown>[] = [];
  const handler = createCronHandler({
    db: r.b.db,
    storage: r.b.storage,
    cronSecret: 'cron-secret',
    claudeMode: 'mock',
    warmClient: null,
    syncNotifications: null,
    now: r.b.now,
    background: (t) => {
      const g = t.then(() => {});
      tasks.push(g);
      return g;
    },
  });
  const call = (body: unknown, secret?: string) =>
    handler(jsonRequest('', body, { fn: 'cron', headers: secret ? { 'x-cron-secret': secret } : {} }));
  await assertApiError(await call({ task: 'daily' }), 'unauthorized');
  await assertApiError(await call({ task: 'nightly' }, 'cron-secret'), 'invalid_payload');
  const res = await call({ task: 'daily' }, 'cron-secret');
  assertEquals(res.status, 202);
  assertEquals(await readJsonResponse(res), { accepted: true, task: 'daily' });
  await Promise.all(tasks);
  assert(r.b.db.callsTo('rpc', 'private.cron_stale_jobs').length === 1);
  assert(r.b.db.callsTo('rpc', 'private.purge_expired_rows').length === 1);
});
