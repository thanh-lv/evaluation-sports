/**
 * prepare() on every synthetic fixture (all launch skills, 30/60 Hz, mirrored, left-handed): contracts, invariants
 * and sensible strokes; plus pose-only mode, rejections and the wrong-hand fallback.
 */
import { assert, assertEquals } from '@std/assert';
import { JOINT_ORDER, PoseV1 } from '@shared/contracts/index.ts';
import { composeScores, prepare, reprepare } from '@shared/engine/index.ts';
import { loadRubric } from '@shared/rubric/load.ts';
import { generateSyntheticPose, SYNTHETIC_FIXTURES } from '../../../../scripts/gen-synthetic-pose.ts';
import { loadPose, prepareOk } from './_prepare.ts';

for (const { name } of SYNTHETIC_FIXTURES) {
  Deno.test(`prepare ${name}: valid prepare.v1 / prepared.v1 / clean-track.v1 with the true strokes`, async () => {
    const { pose, truth } = await loadPose(name);
    const out = prepareOk(pose);
    const { response, prepared } = out;
    assertEquals(response.strokes.length, truth.contactsUs.length);
    // Contacts within 100 ms of the synthetic truth (the signal tests hold the tighter M4b numbers).
    response.strokes.forEach((s, k) => {
      assert(Math.abs(s.tContactUs - truth.contactsUs[k]) <= 100_000, `stroke ${s.id} contact off`);
      assert(s.phases.ready < s.phases.bsEnd && s.phases.bsEnd < s.phases.contact, `stroke ${s.id} phase order`);
      assert(s.phases.contact < s.phases.ftStop, `stroke ${s.id} ftStop`);
      assert(s.quality >= 0.6 && s.quality <= 1, `stroke ${s.id} quality ${s.quality}`);
    });
    assertEquals(response.handednessSuggestion, null);
    assertEquals(response.viewGuess.view, 'side', 'the generator films from the side');
    assertEquals(prepared.view, 'side');
    assertEquals(prepared.direction.f, truth.f);
    assertEquals(prepared.handedness, truth.playsWith);
    // Measured checkpoints exist; V checkpoints are listed for Claude with frames.
    assert(prepared.checkpointTable.some((r) => r.status === 'measured'));
    const v = prepared.checkpointTable.filter((r) => r.status === 'visual' && r.viewFactor > 0);
    assertEquals(prepared.visualToJudge.map((x) => x.checkpointId), v.map((r) => r.id));
    for (const x of prepared.visualToJudge) assert(x.frameIds.length > 0 && x.anchors.length === 5);
    assert(prepared.coverage > 0.4, `coverage ${prepared.coverage}`);
    // Composition without V judgments reproduces the preview.
    const skill = loadRubric(pose.session.sport).skills.find((s) => s.id === pose.session.skill)!;
    const composed = composeScores(prepared.checkpointTable, [], skill);
    assertEquals(composed.subScores.map((s) => s.shown), prepared.subScoresPreview.map((s) => s.shown));
  });
}

Deno.test('prepare is deterministic', async () => {
  const { pose } = await loadPose('synthetic_pb_dink_60');
  assertEquals(prepareOk(pose), prepareOk(pose));
});

Deno.test('mirrored and left-handed clips mirror the right-handed results', async () => {
  const a = prepareOk((await loadPose('synthetic_bd_clear_fh_60')).pose).prepared;
  const b = prepareOk((await loadPose('synthetic_bd_clear_fh_30_mirrored')).pose).prepared;
  // Same skill, different seed / rate: the non-velocity measured statuses agree.
  const st = (p: typeof a) => p.checkpointTable.map((r) => [r.id, r.status]);
  assertEquals(st(a), st(b));
  const left = prepareOk((await loadPose('synthetic_pb_dink_30_left')).pose).prepared;
  assertEquals(left.handedness, 'left');
  const c5 = left.checkpointTable.find((r) => r.joints.some((j) => j.startsWith('l') && /Wri|Elb/.test(j)));
  assert(c5, 'left-handed joints are mirrored onto the left arm');
});

Deno.test('pose_only (minor subject): local frames only, no uploads, V checkpoints without frames', async () => {
  const { pose } = await loadPose('synthetic_bd_smash_30');
  const minor = PoseV1.parse({
    ...pose,
    session: { ...pose.session, subject: 'other', subjectConsent: true, subjectMinor: true },
  });
  const { response, prepared } = prepareOk(minor);
  assertEquals(response.frameMode, 'pose_only');
  assert(response.frameRequests.length >= 5 && response.frameRequests.every((f) => !f.upload));
  assert(prepared.visualToJudge.length > 0 && prepared.visualToJudge.every((v) => v.frameIds.length === 0));
});

Deno.test('rejections: skill not in rubric, target lost, player too small, no strokes', async () => {
  const { pose } = await loadPose('synthetic_pb_serve_30');
  const rubric = loadRubric('pickleball');
  const r1 = prepare(pose, { rubric, skill: 'pb.unknown' });
  assertEquals(r1.ok ? null : r1.code, 'skill_not_available');
  const r1b = prepare(pose, { rubric: loadRubric('badminton') });
  assertEquals(r1b.ok ? null : r1b.code, 'skill_not_available');
  const lost = PoseV1.parse({ ...pose, quality: { ...pose.quality, framesWithTarget: 10 } });
  const r2 = prepare(lost, { rubric });
  assertEquals(r2.ok ? null : [r2.code, r2.tips], ['target_lost', ['camera.tip.one_player', 'camera.tip.full_body']]);
  const small = PoseV1.parse({ ...pose, quality: { ...pose.quality, playerHeightFrac: 0.2 } });
  const r3 = prepare(small, { rubric });
  assertEquals(r3.ok ? null : r3.code, 'player_too_small');
  // A player standing still: no wrist-speed peak.
  const still = PoseV1.parse({ ...pose, track: { ...pose.track, kp: pose.track.kp.map(() => pose.track.kp[0]) } });
  const r4 = prepare(still, { rubric });
  assertEquals(r4.ok ? null : r4.code, 'no_strokes_detected');
  assert(!r4.ok && r4.tips.length > 0);
});

Deno.test('small player (25–35 % of the frame) and 30 Hz produce warnings', async () => {
  const { pose } = await loadPose('synthetic_pb_serve_30');
  const small = PoseV1.parse({ ...pose, quality: { ...pose.quality, playerHeightFrac: 0.3 } });
  const { response } = prepareOk(small);
  assert(response.warnings.includes('player_small'));
  assert(response.warnings.includes('fps_low'));
});

Deno.test('wrong declared hand: suggestion + warning; slow skills fall back to the suggested hand', () => {
  for (const skill of ['pb.dink', 'pb.drop3'] as const) {
    const { pose } = generateSyntheticPose({ skill, hz: 30, seed: 108, playsWith: 'left', declared: 'right' });
    const out = prepareOk(PoseV1.parse(pose));
    assertEquals(out.response.handednessSuggestion, 'left', skill);
    assert(out.response.warnings.includes('handedness_mismatch'));
  }
  // drop3 finds no stroke with the right wrist: segmentation used the left one.
  const { pose } = generateSyntheticPose({
    skill: 'pb.drop3',
    hz: 30,
    seed: 108,
    playsWith: 'left',
    declared: 'right',
  });
  const out = prepareOk(PoseV1.parse(pose));
  assertEquals(out.prepared.handedness, 'left');
  assertEquals(out.response.strokes.length, 3);
});

Deno.test('wrong-hand fallback never overrides an explicit handedness (reprepare after the user answered)', () => {
  const { pose } = generateSyntheticPose({
    skill: 'pb.drop3',
    hz: 30,
    seed: 108,
    playsWith: 'left',
    declared: 'right',
  });
  const parsed = PoseV1.parse(pose);
  const rubric = loadRubric('pickleball');
  // The user confirmed "right": no silent switch to the left wrist.
  const confirmed = reprepare(parsed, { cameraView: 'side', excludedStrokeIds: [], handedness: 'right' }, { rubric });
  assertEquals(confirmed.ok ? confirmed.prepared.handedness : confirmed.code, 'no_strokes_detected');
  // Answering "left" analyses the left wrist.
  const left = reprepare(parsed, { cameraView: 'side', excludedStrokeIds: [], handedness: 'left' }, { rubric });
  assert(left.ok);
  assertEquals([left.prepared.handedness, left.response.handednessSuggestion], ['left', null]);
});

Deno.test('declared racket wrist invisible: low_visibility, never an analysis of the other arm', () => {
  const { pose } = generateSyntheticPose({ skill: 'bd.clear_fh', hz: 60, seed: 1 });
  const ri = JOINT_ORDER.indexOf('rWri') * 3;
  const kp = (pose as { track: { kp: number[][] } }).track.kp.map((row) => {
    const r = row.slice();
    r[ri] = r[ri + 1] = r[ri + 2] = 0;
    return r;
  });
  const parsed = PoseV1.parse({ ...pose, track: { ...(pose as { track: object }).track, kp } });
  const out = prepare(parsed, { rubric: loadRubric('badminton') });
  assertEquals(out.ok ? out.prepared.handedness : out.code, 'low_visibility');
});

Deno.test('a 30 fps source sent with analysisHz 60 still segments (missing-wrist check uses the raw rate)', () => {
  const { pose, truth } = generateSyntheticPose({ skill: 'bd.clear_fh', hz: 30, seed: 2 });
  const p = pose as { video: Record<string, unknown> };
  const parsed = PoseV1.parse({ ...pose, video: { ...p.video, analysisHz: 60 } });
  const out = prepareOk(parsed);
  assertEquals(out.response.strokes.length, truth.contactsUs.length);
});
