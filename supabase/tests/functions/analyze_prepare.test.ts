/**
 * GET /analyze/catalog and POST /analyze/prepare (DESIGN.md §6.1, §7.1–§7.3) with fakes: auth, catalog content and
 * caching, body limits, the 20/h rate limit, catalog check, the ownership-guarded upsert (409), stored files and
 * columns, the quota preview, 422 rejections with tips, and reprepare on the stored raw pose.
 */
import { assert, assertEquals } from '@std/assert';
import { CatalogResponseV1, POSE_V1_MAX_BYTES, PrepareResponseV1, REJECTION_TIPS } from '@shared/contracts/index.ts';
import { BUCKET_DERIVED } from '@shared/storage.ts';
import { assertApiError, readJsonResponse } from '@shared/testing/index.ts';
import { ALICE, BOB, poseBody, rig } from './_analyze.ts';

Deno.test('catalog: JWT required; enabled launch skills only, plans in tier order, cached for 1 h', async () => {
  const r = rig();
  await assertApiError(await r.get('/catalog', null), 'unauthorized');
  const res = await r.get('/catalog');
  assertEquals(res.status, 200);
  assertEquals(res.headers.get('cache-control'), 'private, max-age=3600');
  const body = CatalogResponseV1.parse(await readJsonResponse(res));
  assertEquals(body.skills.map((s) => s.id).sort(), [
    'bd.clear_fh',
    'bd.serve_low',
    'bd.smash',
    'pb.dink',
    'pb.drop3',
    'pb.serve',
  ]);
  assertEquals(body.plans.map((p) => [p.tier, p.totalLimit, p.standardLimit]), [
    ['free', 2, 0],
    ['trial', 10, 5],
    ['premium', 15, 15],
  ]);
  for (const s of body.skills) {
    assert(s.name.vi && s.name.en);
    assertEquals(Object.keys(s.viewCoverage).sort(), [...s.views.allowed].sort());
    for (const v of Object.values(s.viewCoverage)) assert(v! > 0 && v! <= 1);
  }
  const reads = r.b.db.callsTo('selectMany', 'public.enabled_skills').length;
  await (await r.get('/catalog', BOB)).body?.cancel();
  assertEquals(r.b.db.callsTo('selectMany', 'public.enabled_skills').length, reads, 'served from the cache');
});

Deno.test('prepare: 401 without a token, 413 over 1.2 MB, 422 for a wrong schema or a bad pose', async () => {
  const r = rig();
  const pose = await poseBody();
  await assertApiError(await r.post('/prepare', pose, null), 'unauthorized');
  const huge = { ...pose, padding: 'x'.repeat(POSE_V1_MAX_BYTES) };
  await assertApiError(await r.post('/prepare', huge), 'payload_too_large');
  await assertApiError(await r.post('/prepare', { schema: 'pose.v9' }), 'invalid_payload');
  const bad = structuredClone(pose) as unknown as { track: { tUs: number[] } };
  bad.track.tUs[1] = bad.track.tUs[0];
  await assertApiError(await r.post('/prepare', bad), 'invalid_payload');
  assertEquals(r.b.db.table('public', 'analyses').length, 0);
});

Deno.test('prepare: success stores the row, pose.raw.json and pose.clean.json and returns prepare.v1 + quota', async () => {
  const r = rig();
  const pose = await poseBody();
  const res = await r.post('/prepare', pose);
  assertEquals(res.status, 200);
  const body = PrepareResponseV1.parse(await readJsonResponse(res));
  assertEquals(body.analysisId, pose.analysisId);
  assertEquals(body.quota, { tier: 'free', remaining: 2, nextKind: 'standard', resetsAt: '2026-11-01T00:00:00+07:00' });
  assertEquals(body.cleanTrackPath, `${ALICE}/${pose.analysisId}/pose.clean.json`);

  const row = r.b.analysis(pose.analysisId)!;
  assertEquals(row.user_id, ALICE);
  assertEquals(row.status, 'prepared');
  assertEquals(row.frame_mode, 'frames');
  assertEquals(row.frame_count, 5);
  assertEquals(row.language, pose.session.language);
  assertEquals(row.view_confirmed, (row.prepared as { view: string }).view);
  assertEquals(row.algo_version, 'engine-1.1.0');
  assert(/^[0-9a-f]{64}$/.test(row.rubric_version as string), 'rubric_version is the sha256');
  assertEquals(r.b.memory.paths(BUCKET_DERIVED), [
    `${ALICE}/${pose.analysisId}/pose.clean.json`,
    `${ALICE}/${pose.analysisId}/pose.raw.json`,
  ]);
});

Deno.test('prepare: pose_only for a minor subject uploads no frames', async () => {
  const r = rig();
  const pose = await poseBody('synthetic_pb_dink_60', { subjectMinor: true });
  const body = PrepareResponseV1.parse(await readJsonResponse(await r.post('/prepare', pose)));
  assertEquals(body.frameMode, 'pose_only');
  assertEquals(body.frameRequests.filter((f) => f.upload).length, 0);
  assertEquals(r.b.analysis(pose.analysisId)!.frame_count, 0);
});

Deno.test("prepare: 409 analysis_conflict for another user's id or a submitted analysis; nothing is overwritten", async () => {
  const r = rig();
  const pose = await poseBody();
  assertEquals((await r.post('/prepare', pose, BOB)).status, 200);
  const before = r.b.memory.paths(BUCKET_DERIVED);
  await assertApiError(await r.post('/prepare', pose, ALICE), 'analysis_conflict');
  assertEquals(r.b.analysis(pose.analysisId)!.user_id, BOB);
  assertEquals(r.b.memory.paths(BUCKET_DERIVED), before, 'no file written under the other user');

  // Race: the pre-check passes but the upsert loses (row submitted meanwhile) → still 409.
  const mine = await poseBody();
  assertEquals((await r.post('/prepare', mine)).status, 200);
  r.b.analysis(mine.analysisId)!.status = 'queued';
  await assertApiError(await r.post('/prepare', mine), 'analysis_conflict');
});

Deno.test('prepare: the same user may re-prepare a draft (upsert)', async () => {
  const r = rig();
  const pose = await poseBody();
  assertEquals((await r.post('/prepare', pose)).status, 200);
  assertEquals((await r.post('/prepare', pose)).status, 200);
  assertEquals(r.b.db.table('public', 'analyses').length, 1);
});

Deno.test('prepare: rate limit 20 pose.v1 per hour per user → 429 with Retry-After', async () => {
  const r = rig({ limits: { preparePerHour: 2 } });
  const pose = await poseBody();
  assertEquals((await r.post('/prepare', pose)).status, 200);
  assertEquals((await r.post('/prepare', pose)).status, 200);
  const res = await r.post('/prepare', pose);
  await assertApiError(res, 'rate_limited');
  assertEquals(res.headers.get('retry-after'), '1800');
  assertEquals((await r.post('/prepare', await poseBody(), BOB)).status, 200, 'per user');
});

Deno.test('prepare: a disabled skill → 422 skill_not_available with tips', async () => {
  const r = rig();
  r.b.db.table('public', 'enabled_skills').find((s) => s.skill === 'bd.clear_fh')!.enabled = false;
  const body = await assertApiError(await r.post('/prepare', await poseBody()), 'skill_not_available');
  assertEquals(body.tips, [...REJECTION_TIPS.skill_not_available]);
});

Deno.test('prepare: an engine rejection → 422 with tips, stored as a rejected draft with the raw pose', async () => {
  const r = rig();
  const pose = await poseBody();
  pose.quality.playerHeightFrac = 0.1;
  const body = await assertApiError(await r.post('/prepare', pose), 'player_too_small');
  assertEquals(body.tips, [...REJECTION_TIPS.player_too_small]);
  const row = r.b.analysis(pose.analysisId)!;
  assertEquals([row.status, row.failure_code], ['rejected', 'player_too_small']);
  assertEquals(r.b.memory.paths(BUCKET_DERIVED), [`${ALICE}/${pose.analysisId}/pose.raw.json`]);
});

Deno.test('reprepare: re-runs the stored raw pose with the confirmed view, excluded strokes and hand', async () => {
  const r = rig();
  const pose = await poseBody();
  const first = PrepareResponseV1.parse(await readJsonResponse(await r.post('/prepare', pose)));
  assert(first.strokes.length >= 2);
  const drop = first.strokes[0].id;
  const res = await r.post('/prepare', {
    schema: 'reprepare.v1',
    analysisId: pose.analysisId,
    cameraView: 'diagonal',
    excludedStrokeIds: [drop],
    handedness: pose.session.handedness,
  });
  assertEquals(res.status, 200);
  const body = PrepareResponseV1.parse(await readJsonResponse(res));
  assertEquals(body.strokes.find((s) => s.id === drop)!.excluded, true);
  const row = r.b.analysis(pose.analysisId)!;
  assertEquals(row.view_confirmed, 'diagonal');
  assertEquals(row.excluded_strokes, [drop]);
  assertEquals(row.camera_view, pose.session.cameraView, 'the original pick is kept');

  // excluding every stroke → 422 no_strokes_detected, the draft becomes rejected (raw pose kept for another try)
  const all = await r.post('/prepare', {
    schema: 'reprepare.v1',
    analysisId: pose.analysisId,
    cameraView: 'side',
    excludedStrokeIds: first.strokes.map((s) => s.id),
    handedness: pose.session.handedness,
  });
  await assertApiError(all, 'no_strokes_detected');
  assertEquals(r.b.analysis(pose.analysisId)!.status, 'rejected');
  const again = await r.post('/prepare', {
    schema: 'reprepare.v1',
    analysisId: pose.analysisId,
    cameraView: 'side',
    excludedStrokeIds: [],
    handedness: pose.session.handedness,
  });
  assertEquals(again.status, 200);
  assertEquals(r.b.analysis(pose.analysisId)!.status, 'prepared');
});

Deno.test('reprepare: 404 for an unknown or foreign id, 409 once submitted', async () => {
  const r = rig();
  const pose = await poseBody();
  await (await r.post('/prepare', pose)).body?.cancel();
  const req = (id: string) => ({
    schema: 'reprepare.v1',
    analysisId: id,
    cameraView: 'side',
    excludedStrokeIds: [],
    handedness: 'right',
  });
  await assertApiError(await r.post('/prepare', req(crypto.randomUUID())), 'analysis_not_found');
  await assertApiError(await r.post('/prepare', req(pose.analysisId), BOB), 'analysis_not_found');
  r.b.analysis(pose.analysisId)!.status = 'queued';
  await assertApiError(await r.post('/prepare', req(pose.analysisId)), 'analysis_conflict');
});
