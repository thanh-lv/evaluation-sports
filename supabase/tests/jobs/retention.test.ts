/**
 * Daily cron (DESIGN.md §6.6, §8.2): the 72 h cap claims before failing, 24 h drafts, the orphan walk, pose JSON after
 * inactivity, the warm-up (live only) and step isolation.
 */
import { assert, assertEquals } from '@std/assert';
import {
  cleanOrphans,
  deleteExpiredDrafts,
  expireStaleJobs,
  keepFrames,
  purgeInactivePose,
  runCronTask,
  WARM_MARKER_IDS,
  warmStaleSchemas,
} from '@shared/jobs/index.ts';
import { staticCoachClient } from '@shared/claude/index.ts';
import { BUCKET_DERIVED, BUCKET_INPUTS } from '@shared/storage.ts';
import { captureLogger } from '@shared/testing/index.ts';
import { createBackend } from './_backend.ts';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const A = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const HOUR = 3600_000;

function setup() {
  const b = createBackend();
  b.addUser(U1);
  b.addUser(U2);
  const { log, lines } = captureLogger();
  return { b, log, lines, deps: { db: b.db, storage: b.storage, log, now: b.now } };
}

function frames(b: ReturnType<typeof createBackend>, uid: string, aid: string) {
  for (const f of ['F1', 'F2']) b.memory.put(BUCKET_INPUTS, `${uid}/${aid}/frames/${f}.jpg`, 'x', 'image/jpeg');
}

Deno.test('retention: jobs past 72 h are claimed, failed (expired, refunded) and lose their frames', async () => {
  const { b, deps } = setup();
  b.seedJob({ id: A(1), user_id: U1 }); // queued, will be stale
  b.seedJob({ id: A(2), user_id: U2 }); // processing with a fresh lock: a live worker owns it
  frames(b, U1, A(1));
  b.advance(73 * HOUR);
  Object.assign(b.analysis(A(2))!, { status: 'processing', attempt_count: 1, locked_at: b.now().toISOString() });
  b.seedJob({ id: A(3), user_id: U1, queued_at: b.now().toISOString() }); // recent

  assertEquals(await expireStaleJobs(deps), { expired: 1, skipped: 1 });
  assertEquals(b.analysis(A(1))!.status, 'failed');
  assertEquals(b.analysis(A(1))!.failure_code, 'expired');
  assertEquals(b.ledger.get(A(1))!.state, 'refunded');
  assertEquals(b.analysis(A(2))!.status, 'processing', 'never failed under a live worker');
  assertEquals(b.analysis(A(3))!.status, 'queued');
  assertEquals(b.memory.paths(BUCKET_INPUTS), []);
});

Deno.test('retention: drafts older than 24 h are deleted with their files; submitted ones survive', async () => {
  const { b, deps } = setup();
  const draft = {
    user_id: U1,
    status: 'prepared',
    created_at: b.now().toISOString(),
    updated_at: b.now().toISOString(),
  };
  b.db.table('public', 'analyses').push({ ...draft, id: A(1) }, { ...draft, id: A(2), status: 'rejected' });
  b.memory.put(BUCKET_DERIVED, `${U1}/${A(1)}/pose.raw.json`);
  b.memory.put(BUCKET_INPUTS, `${U1}/${A(1)}/frames/F1.jpg`, 'x');
  b.advance(25 * HOUR);
  b.db.table('public', 'analyses').push({ ...draft, id: A(3), updated_at: b.now().toISOString() });
  assertEquals(await deleteExpiredDrafts(deps), { deleted: 2 });
  assertEquals(b.db.table('public', 'analyses').map((r) => r.id), [A(3)]);
  assertEquals(b.memory.paths(BUCKET_DERIVED), []);
  assertEquals(b.memory.paths(BUCKET_INPUTS), []);
});

Deno.test('retention: keepFrames keeps live jobs and failures for 72 h', () => {
  const now = new Date('2026-10-20T00:00:00Z');
  const recent = new Date(now.getTime() - 10 * HOUR).toISOString();
  const old = new Date(now.getTime() - 80 * HOUR).toISOString();
  assertEquals(keepFrames({ id: 'x', status: 'queued', completed_at: null }, now), true);
  assertEquals(keepFrames({ id: 'x', status: 'prepared', completed_at: null }, now), true);
  assertEquals(keepFrames({ id: 'x', status: 'failed', completed_at: recent }, now), true);
  assertEquals(keepFrames({ id: 'x', status: 'failed', completed_at: old }, now), false);
  assertEquals(keepFrames({ id: 'x', status: 'succeeded', completed_at: recent }, now), false);
});

Deno.test('retention: the orphan walk removes folders without an analysis row, recursively, in both buckets', async () => {
  const { b, deps } = setup();
  const gone = '33333333-3333-4333-8333-333333333333'; // deleted user
  b.db.table('public', 'analyses').push(
    { id: A(1), user_id: U1, status: 'succeeded', completed_at: b.now().toISOString() },
    { id: A(2), user_id: U1, status: 'queued', completed_at: null },
  );
  frames(b, U1, A(1)); // finished job: leftover frames
  frames(b, U1, A(2)); // live job: kept
  frames(b, U1, A(9)); // no row: orphan
  b.memory.put(BUCKET_DERIVED, `${U1}/${A(1)}/pose.raw.json`); // kept with its analysis
  b.memory.put(BUCKET_DERIVED, `${U1}/${A(9)}/deep/nested/pose.clean.json`); // orphan, nested
  b.memory.put(BUCKET_DERIVED, `${gone}/${A(5)}/pose.raw.json`);
  b.memory.put(BUCKET_INPUTS, `${U2}/stray.jpg`, 'x');

  const r = await cleanOrphans(deps, { startAt: 0 });
  assertEquals(r.complete, true);
  assertEquals(r.orphanFolders, 3);
  assertEquals(r.frameFolders, 1);
  assertEquals(b.memory.paths(BUCKET_INPUTS), [`${U1}/${A(2)}/frames/F1.jpg`, `${U1}/${A(2)}/frames/F2.jpg`]);
  assertEquals(b.memory.paths(BUCKET_DERIVED), [`${U1}/${A(1)}/pose.raw.json`]);
  const again = await cleanOrphans(deps, { startAt: 1 });
  assertEquals([again.orphanFolders, again.frameFolders], [0, 0], 'idempotent');
});

Deno.test('retention: the walk stops at its time budget and reports it', async () => {
  const { b, deps } = setup();
  b.memory.put(BUCKET_DERIVED, `${U1}/${A(1)}/pose.raw.json`);
  const r = await cleanOrphans(deps, { budgetMs: -1 });
  assertEquals(r.complete, false);
  assertEquals(b.memory.paths(BUCKET_DERIVED).length, 1);
});

Deno.test('retention: pose JSON of inactive owners is removed and the paths cleared', async () => {
  const { b, deps } = setup();
  b.db.table('public', 'analyses').push({
    id: A(1),
    user_id: U1,
    status: 'succeeded',
    inactive_owner: true,
    pose_raw_path: `${U1}/${A(1)}/pose.raw.json`,
    pose_clean_path: `${U1}/${A(1)}/pose.clean.json`,
  });
  b.memory.put(BUCKET_DERIVED, `${U1}/${A(1)}/pose.raw.json`);
  b.memory.put(BUCKET_DERIVED, `${U1}/${A(1)}/pose.clean.json`);
  assertEquals(await purgeInactivePose(deps), { analyses: 1 });
  assertEquals(b.memory.paths(BUCKET_DERIVED), []);
  assertEquals(b.analysis(A(1))!.pose_raw_path, null);
  assertEquals(await purgeInactivePose(deps), { analyses: 0 });
});

Deno.test('cron: daily runs every step; a failing step does not stop the others; warm is live-only', async () => {
  const { b, log, lines } = setup();
  b.db.onRpc('private', 'cron_inactive_pose', () => {
    throw new Error('boom');
  });
  let synced = 0;
  const out = await runCronTask('daily', {
    db: b.db,
    storage: b.storage,
    log,
    now: b.now,
    claudeMode: 'mock',
    warmClient: null,
    syncNotifications: () => Promise.resolve(++synced),
  });
  assertEquals(Object.keys(out), [
    'staleJobs',
    'drafts',
    'orphans',
    'inactivePose',
    'rows',
    'notifications',
    'spend',
    'warm',
  ]);
  assertEquals(out.inactivePose.ok, false);
  assertEquals(out.spend.ok, true);
  assertEquals(synced, 1);
  assertEquals(out.warm, { ok: true, skipped: 'CLAUDE_MODE is not live' });
  assert(lines.some((l) => l.entry.msg === 'cron step failed' && l.entry.step === 'inactive_pose'));

  const warmOnly = await runCronTask('warm', {
    db: b.db,
    storage: b.storage,
    log,
    claudeMode: 'mock',
    warmClient: null,
    syncNotifications: null,
  });
  assertEquals(Object.keys(warmOnly), ['warm']);
});

Deno.test('warm: only model × sport pairs without a call in 20 h are warmed; calls are logged under markers', async () => {
  const { b, log } = setup();
  // Sonnet served a badminton analysis recently; a Haiku pickleball warm-up ran recently (marker id).
  b.db.table('private', 'recent_model_use').push(
    { model: 'claude-sonnet-5-5', sport: 'badminton', analysis_id: null },
    { model: 'claude-haiku-5-5', sport: null, analysis_id: WARM_MARKER_IDS.pickleball },
  );
  const seen: string[] = [];
  const client = staticCoachClient(() => ({}), 'max_tokens');
  const wrapped = {
    name: 'warm',
    create: (p: Parameters<typeof client.create>[0], o: Parameters<typeof client.create>[1]) => {
      seen.push(`${p.model}|${p.output_config?.format?.type}|${p.max_tokens}`);
      return client.create(p, o);
    },
  };
  const r = await warmStaleSchemas({ db: b.db, client: wrapped, log });
  assertEquals(r.skipped, 2);
  assertEquals(r.warmed.map((w) => `${w.model}|${w.sport}|${w.ok}`).sort(), [
    'claude-haiku-5-5|badminton|true',
    'claude-sonnet-5-5|pickleball|true',
  ]);
  assertEquals(seen.every((s) => s.endsWith('|json_schema|64')), true);
  const calls = b.db.table('private', 'llm_calls');
  assertEquals(calls.map((c) => c.analysis_id).sort(), [WARM_MARKER_IDS.badminton, WARM_MARKER_IDS.pickleball].sort());
  assertEquals(calls.every((c) => c.attempt === 0), true);
});

Deno.test('warm: a rejected schema (400) raises an operator alert', async () => {
  const { b, lines, log } = setup();
  const { APIError } = await import('@anthropic-ai/sdk');
  const client = {
    name: 'bad',
    create: () => Promise.reject(new APIError(400, undefined, 'Schema is too complex', new Headers())),
  };
  const r = await warmStaleSchemas({ db: b.db, client, log });
  assertEquals(r.warmed.length, 4);
  assertEquals(r.warmed.every((w) => !w.ok), true);
  assertEquals(lines.filter((l) => l.entry.msg === 'alert: schema_warm_failed').length, 4);
});
