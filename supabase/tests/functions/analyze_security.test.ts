/**
 * Review hardening of the analyze/cron functions: shared-secret routes fail closed when the secret is not configured,
 * mock mode is never a silent fallback for live mode, and a job without a usable model client fails at once (refund).
 */
import { assert, assertEquals, assertThrows } from '@std/assert';
import { type CoachModelClient, type MockSource } from '@shared/claude/index.ts';
import { ConfigError } from '@shared/errors.ts';
import { runOnce } from '@shared/jobs/index.ts';
import { assertApiError, jsonRequest } from '@shared/testing/index.ts';
import { coachClientFactory } from '../../functions/analyze/deps.ts';
import { createAnalyzeHandler } from '../../functions/analyze/handler.ts';
import { createCronHandler } from '../../functions/cron/handler.ts';
import { jobFixture } from '../jobs/_jobs.ts';
import { rig } from './_analyze.ts';

const ID = '0f0f0f0f-0000-4000-8000-000000000001';

Deno.test('run/cron: an unconfigured secret is a 500, never an open door (even with an empty header)', async () => {
  const r = rig();
  const handler = createAnalyzeHandler({
    db: r.b.db,
    storage: r.b.storage,
    verifier: r.verifier,
    internalSecret: null,
    deviceCheck: null,
    coachClient: r.client.factory,
    background: (t) => t.then(() => {}),
  });
  const variants: Record<string, string>[] = [{}, { 'x-internal-secret': '' }, { 'x-internal-secret': 'null' }];
  for (const headers of variants) {
    await assertApiError(await handler(jsonRequest('/run', { analysisId: ID }, { headers })), 'internal');
  }
  assertEquals(r.client.calls.length, 0);

  const cron = createCronHandler({
    db: r.b.db,
    storage: r.b.storage,
    cronSecret: null,
    claudeMode: 'mock',
    warmClient: null,
    syncNotifications: null,
  });
  const res = await cron(jsonRequest('', { task: 'daily' }, { fn: 'cron', headers: { 'x-cron-secret': '' } }));
  await assertApiError(res, 'internal');
  assertEquals(r.b.db.callsTo('rpc', 'private.cron_stale_jobs').length, 0);
});

Deno.test('run: a user JWT is not a substitute for x-internal-secret; prefix of the secret is rejected', async () => {
  const r = rig();
  await assertApiError(await r.post('/run', { analysisId: ID }), 'unauthorized');
  await assertApiError(
    await r.post('/run', { analysisId: ID }, null, { 'x-internal-secret': 'internal-secret' }),
    'unauthorized',
  );
});

const SRC = {} as MockSource;

Deno.test('coachClientFactory: mock only when CLAUDE_MODE=mock; live without a key throws ConfigError', () => {
  const made: string[] = [];
  const fakeLive = (o: { apiKey: string }): CoachModelClient => {
    made.push(o.apiKey);
    return { name: 'anthropic', create: () => Promise.reject(new Error('unused')) };
  };
  assertEquals(coachClientFactory('mock', 'sk-ant-x', fakeLive)(SRC).name, 'mock');
  assertEquals(made, [], 'mock mode builds no SDK client');

  const noKey = coachClientFactory('live', null, fakeLive);
  assertThrows(() => noKey(SRC), ConfigError, 'ANTHROPIC_API_KEY');

  const live = coachClientFactory('live', 'sk-ant-x', fakeLive);
  assertEquals(live(SRC).name, 'anthropic');
  assert(live(SRC) === live(SRC), 'one SDK client per worker');
  assertEquals(made, ['sk-ant-x']);
});

Deno.test('runOnce: live mode without a key fails the job at once (internal, refund, alert), no retries', async () => {
  const f = await jobFixture();
  f.deps.coachClient = coachClientFactory('live', null);
  const r = await runOnce(f.id, f.deps);
  assertEquals(r, { status: 'failed', attempt: 1, code: 'internal' });
  assertEquals(f.backend.analysis(f.id)!.status, 'failed');
  assertEquals(f.backend.ledger.get(f.id)!.state, 'refunded');
  assert(f.lines.some((l) => l.level === 'error' && l.entry.alert === true), 'operator alert');
});
