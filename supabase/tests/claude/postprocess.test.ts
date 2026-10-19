/** Post-processing (DESIGN.md §8.4 steps 1–8). */
import { assert, assertEquals, assertExists, assertFalse } from '@std/assert';
import type { CoachOutputV1 } from '@shared/contracts/coach_output.ts';
import { mockCoachOutput, postprocess, type PostprocessOk, type PostprocessResult } from '@shared/claude/index.ts';
import { loadFixture } from '../_helpers/fixtures.ts';
import { ppContext, type Prepared, preparedFixture } from './_claude.ts';

const BD = 'synthetic_bd_clear_fh_60';

function ok(r: PostprocessResult): PostprocessOk {
  assertEquals(r.status, 'ok', JSON.stringify(r.flags));
  return r as PostprocessOk;
}

const flagsOf = (r: PostprocessResult, type: string) => r.flags.filter((f) => f.type === type);

async function base(lang: 'vi' | 'en' = 'en', name = BD): Promise<{ fx: Prepared; out: CoachOutputV1 }> {
  const fx = await preparedFixture(name);
  return { fx, out: structuredClone(mockCoachOutput(ppContext(fx, lang))) };
}

Deno.test('the mock output passes postprocess unchanged (no flags)', async () => {
  for (const lang of ['vi', 'en'] as const) {
    const { fx, out } = await base(lang);
    const r = ok(postprocess(out, ppContext(fx, lang)));
    assertEquals(r.flags, []);
    assertEquals(r.weaknesses.map((w) => w.checkpointId), out.weaknesses.map((w) => w.checkpoint_id));
    assertEquals(r.summary, out.summary);
  }
});

Deno.test('step 1: input check → rejected with tips (frames sent); ignored in pose_only', async () => {
  const { fx, out } = await base('vi');
  out.input_check.sport_matches = false;
  out.input_check.note = 'Video có vẻ là quần vợt, không phải cầu lông.';
  const r = postprocess(out, ppContext(fx, 'vi'));
  assertEquals(r.status, 'rejected');
  if (r.status === 'rejected') {
    assertEquals(r.rejection.code, 'wrong_sport');
    assert(r.rejection.tips.length > 0);
    assertEquals(r.summary, out.input_check.note);
  }
  const out2 = structuredClone(out);
  out2.input_check.sport_matches = true;
  out2.input_check.skill_matches = false;
  out2.input_check.subject_visibility = 'Poor';
  const r2 = postprocess(out2, ppContext(fx, 'vi'));
  assertEquals(r2.status === 'rejected' && r2.rejection.code, 'wrong_skill');
  // skill mismatch with good visibility is not a rejection
  out2.input_check.subject_visibility = 'good';
  assertEquals(postprocess(out2, ppContext(fx, 'vi')).status, 'ok');

  const po = await preparedFixture(BD, 'pose_only');
  const out3 = mockCoachOutput(ppContext(po, 'vi'));
  out3.input_check.is_assessable = false;
  const r3 = postprocess(out3, ppContext(po, 'vi'));
  assertEquals(r3.status, 'ok');
  assertEquals(flagsOf(r3, 'input_check_ignored').length, 1);
});

Deno.test('step 2: capitalised enums are normalised; unknown ids are dropped', async () => {
  const { fx, out } = await base();
  out.input_check.subject_visibility = 'GOOD';
  out.input_check.issues = ['Too_Far', 'made_up_issue'];
  out.weaknesses[0].checkpoint_id = out.weaknesses[0].checkpoint_id.toUpperCase();
  out.weaknesses[0].fault_id = out.weaknesses[0].fault_id.toUpperCase();
  out.weaknesses[0].severity = 'High';
  out.visual_checkpoints[0].confidence = 'Medium';
  out.safety_notes = [{ kind: 'WarmUp', message: 'Warm up first.' }, { kind: 'nonsense', message: 'x' }];
  out.weaknesses.push({ ...structuredClone(out.weaknesses[1]), checkpoint_id: 'bd.clear_fh.C99' });
  const r = ok(postprocess(out, ppContext(fx, 'en')));
  assertEquals(r.inputCheck.visibility, 'good');
  assertEquals(r.inputCheck.issues, ['too_far']);
  assertEquals(r.weaknesses[0].checkpointId, 'bd.clear_fh.C5');
  assertEquals(r.weaknesses[0].faultId, 'bd.clear_fh.low_contact');
  assertEquals(r.weaknesses[0].severity, 'high');
  assertEquals(r.visual[0].confidence, 'medium');
  assertEquals(r.safetyNotes, [{ kind: 'warmup', message: 'Warm up first.' }]);
  assertEquals(r.weaknesses.length, 2);
  assert(r.flags.some((f) => f.type === 'enum_dropped' && f.detail.includes('C99')));
});

Deno.test('step 3: visual checkpoints — this skill only, clamped, unsent frames dropped, pose_only → -1', async () => {
  const { fx, out } = await base();
  out.visual_checkpoints[0].level = 7;
  out.visual_checkpoints[0].frame_ids = ['F1', 'F9', 'L1', 'f5'];
  out.visual_checkpoints[1].level = -3;
  out.visual_checkpoints.push({ checkpoint_id: 'bd.smash.S1', level: 2, confidence: 'high', frame_ids: [], note: '' });
  const r = ok(postprocess(out, ppContext(fx, 'en')));
  assertEquals(r.visual.length, 2);
  assertEquals(r.visual[0].level, 4);
  assertEquals(r.visual[0].frameIds, ['F1', 'F5']);
  assertEquals(r.visual[1].level, -1);
  assertEquals(flagsOf(r, 'visual_dropped').length, 1);
  assertEquals(r.visualJudgments.length, 2);

  const po = await preparedFixture(BD, 'pose_only');
  const out2 = mockCoachOutput(ppContext(po, 'en'));
  for (const v of out2.visual_checkpoints) v.level = 3;
  const r2 = ok(postprocess(out2, ppContext(po, 'en')));
  assert(r2.visual.every((v) => v.level === -1 && v.frameIds.length === 0));
});

Deno.test('step 4: grounding — non-candidate findings dropped, confident visual findings kept', async () => {
  const { fx, out } = await base();
  const ctx = ppContext(fx, 'en');
  // C9 is neither a weakness candidate nor a visual item → dropped.
  out.weaknesses.push({ ...structuredClone(out.weaknesses[1]), checkpoint_id: 'bd.clear_fh.C9' });
  // C13 is a V item: level 4, confidence high → a valid visual strength.
  out.visual_checkpoints[1] = { ...out.visual_checkpoints[1], level: 4, confidence: 'high' };
  out.strengths.push({
    checkpoint_id: 'bd.clear_fh.C13',
    title: 'Early behind the shuttle',
    detail: 'You get behind the shuttle early.',
    evidence: [{ stroke_id: 2, frame_id: 'F2', metric_key: '', observation: 'Set early behind the shuttle, side-on.' }],
  });
  // A strength with low-confidence visual support only → dropped.
  out.visual_checkpoints[0] = { ...out.visual_checkpoints[0], level: 4, confidence: 'low' };
  out.strengths.push({ ...structuredClone(out.strengths[0]), checkpoint_id: 'bd.ready.R7' });
  const r = ok(postprocess(out, ctx));
  assertFalse(r.weaknesses.some((w) => w.checkpointId === 'bd.clear_fh.C9'));
  const c13 = r.strengths.find((s) => s.checkpointId === 'bd.clear_fh.C13');
  assertExists(c13);
  assertEquals(c13.source, 'visual');
  assertFalse(r.strengths.some((s) => s.checkpointId === 'bd.ready.R7'));
  assertEquals(flagsOf(r, 'finding_dropped').length, 2);
});

Deno.test('step 4: evidence validation and observation hygiene', async () => {
  const { fx, out } = await base();
  const w = out.weaknesses[0];
  w.evidence = [
    { stroke_id: 99, frame_id: 'F3', metric_key: w.checkpoint_id, observation: 'Invalid stroke id here.' },
    { stroke_id: 2, frame_id: 'L3', metric_key: 'bd.clear_fh.C42', observation: 'Neither frame nor metric valid.' },
    {
      stroke_id: 2,
      frame_id: 'F3',
      metric_key: w.checkpoint_id,
      observation: 'Your arm is bent at 95° when you hit, about 12 cm low.',
    },
    { stroke_id: 4, frame_id: '', metric_key: w.checkpoint_id, observation: '142°' },
  ];
  const r = ok(postprocess(out, ppContext(fx, 'en')));
  const ev = r.weaknesses[0].evidence;
  assertEquals(ev.length, 2);
  assertEquals(ev[0].observation, 'Your arm is bent when you hit, low.');
  assertFalse(/\d/.test(ev[0].observation));
  // < 3 words after stripping → the catalog plain template
  assertEquals(ev[1].observation, 'Contact low, arm not reaching up.');
  assertEquals(ev[1].frameId, null);
  assertEquals(flagsOf(r, 'evidence_dropped').length, 2);
  assertEquals(flagsOf(r, 'observation_stripped').length, 2);
  assertEquals(flagsOf(r, 'observation_replaced').length, 1);
  // A finding whose evidence is all invalid gets one catalog evidence item.
  out.weaknesses[1].evidence = [{ stroke_id: 7, frame_id: 'F8', metric_key: 'x', observation: 'nope' }];
  const r2 = ok(postprocess(out, ppContext(fx, 'en')));
  assertEquals(r2.weaknesses[1].evidence.length, 1);
  assertEquals(r2.weaknesses[1].evidence[0].metricKey, out.weaknesses[1].checkpoint_id);
  assertEquals(flagsOf(r2, 'evidence_added').length, 1);
});

Deno.test('step 5: deterministic override inserts the dominant omitted candidate', async () => {
  const { fx, out } = await base();
  const prepared = structuredClone(fx.prepared);
  const [w1, w2] = prepared.candidates.weaknesses;
  w1.impact = 0.6;
  w1.c = 0.8;
  w2.impact = 0.3;
  const ctx = { ...ppContext({ prepared, rubric: fx.rubric }, 'en') };
  out.weaknesses = out.weaknesses.filter((w) => w.checkpoint_id !== w1.checkpointId);
  out.improvements = out.improvements.filter((m) => m.fault_id !== w1.faultId);
  const r = ok(postprocess(out, ctx));
  assertEquals(r.weaknesses[0].checkpointId, w1.checkpointId);
  assertEquals(r.weaknesses[0].source, 'override');
  assertEquals(r.weaknesses[0].faultId, w1.faultId);
  assertEquals(flagsOf(r, 'override').length, 1);
  assertEquals(r.improvements[0].faultId, w1.faultId);
  assertEquals(flagsOf(r, 'improvement_added').length, 1);
  // Not dominant enough (impact < 1.5× the next) → no override.
  w2.impact = 0.5;
  assertEquals(flagsOf(postprocess(out, ctx), 'override').length, 0);
  // Low reliability → no override.
  w2.impact = 0.3;
  w1.c = 0.5;
  assertEquals(flagsOf(postprocess(out, ctx), 'override').length, 0);
});

Deno.test('step 7: ≤ 3 improvements in weakness order, drills validated against the fault', async () => {
  const { fx, out } = await base();
  out.improvements[0].drill_ids = ['bd.drill.towel_snap', 'bd.drill.does_not_exist'];
  out.improvements[1].drill_ids = ['BD.DRILL.SCISSOR_SHADOW', 'bd.drill.shadow_turn_point'];
  out.improvements.reverse(); // priority, not array order, decides
  const r = ok(postprocess(out, ppContext(fx, 'en')));
  assertEquals(r.improvements.length, 2);
  assertEquals(r.improvements[0].faultId, 'bd.clear_fh.low_contact');
  assertEquals(r.improvements[0].drillIds, ['bd.drill.hanging_shuttle']); // default drill of low_contact
  assertEquals(r.improvements[1].drillIds, ['bd.drill.scissor_shadow', 'bd.drill.shadow_turn_point']);
  assertEquals(flagsOf(r, 'drill_replaced').length, 1);
  // At most 3 weaknesses / improvements.
  const many = await base('en');
  const extra = many.fx.prepared.candidates.weaknesses.slice(2, 5).map((c) => ({
    ...structuredClone(many.out.weaknesses[1]),
    checkpoint_id: c.checkpointId,
    fault_id: c.faultId ?? 'none',
  }));
  many.out.weaknesses.push(...extra);
  const r2 = ok(postprocess(many.out, ppContext(many.fx, 'en')));
  assertEquals(r2.weaknesses.length, 3);
  assertEquals(r2.improvements.length, 3);
});

Deno.test('step 8: medical terms are replaced and flagged; "teardrop" passes', async () => {
  const { fx, out } = await base();
  out.weaknesses[0].detail = 'This pattern often leads to tendinitis in the shoulder.';
  out.improvements[0].cues = ['Teardrop arc over the net', 'Avoid a rotator cuff tear'];
  out.summary = 'Bạn có thể bị viêm gân nếu tiếp tục.';
  const r = ok(postprocess(out, ppContext(fx, 'en')));
  assertFalse(r.weaknesses[0].detail.includes('tendinitis'));
  assertEquals(r.weaknesses[0].detail, 'Contact low, arm not reaching up.');
  assertEquals(r.improvements[0].cues, ['Teardrop arc over the net']);
  assertFalse(r.summary.includes('viêm'));
  assert(r.medicalHit);
  assertEquals(flagsOf(r, 'flag_medical').length, 3);
});

Deno.test('realistic Claude fixtures: quirks are normalised, findings grounded', async () => {
  const fx = await preparedFixture(BD);
  const vi = await loadFixture<CoachOutputV1>('claude/bd_clear_fh_60.vi.json');
  const r = ok(postprocess(vi, ppContext(fx, 'vi')));
  assertEquals(r.inputCheck.visibility, 'good');
  assertEquals(r.weaknesses[0].severity, 'high');
  assertEquals(r.weaknesses.map((w) => w.checkpointId), ['bd.clear_fh.C5', 'bd.clear_fh.C1']);
  assertEquals(r.improvements[1].drillIds, ['bd.drill.shadow_turn_point']); // towel_snap is not a no_turn drill
  assert(r.weaknesses.every((w) => w.evidence.every((e) => !/\d/.test(e.observation))));
  assertEquals(flagsOf(r, 'observation_stripped').length, 1);

  const pb = await preparedFixture('synthetic_pb_dink_60');
  const en = await loadFixture<CoachOutputV1>('claude/pb_dink_60.en.json');
  const r2 = ok(postprocess(en, ppContext(pb, 'en')));
  assertEquals(r2.flags, []);
  assertEquals(r2.strengths.find((s) => s.checkpointId === 'pb.dink.DK4')?.source, 'visual');
});
