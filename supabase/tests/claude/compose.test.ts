/** Compose (DESIGN.md §8.4 steps 6 and 9): a valid full coach-result.v1 for every synthetic fixture. */
import { assert, assertEquals, assertFalse, assertNotEquals } from '@std/assert';
import { COACH_SCHEMA_VERSION, CoachResultV1 } from '@shared/contracts/index.ts';
import type { CoachOutputV1 } from '@shared/contracts/coach_output.ts';
import { composeResult, mockCoachOutput, postprocess, PROMPT_VERSION } from '@shared/claude/index.ts';
import { loadFixture } from '../_helpers/fixtures.ts';
import { CREATED_AT, ppContext, type Prepared, preparedFixture, SYNTHETIC } from './_claude.ts';

function composeMock(fx: Prepared, lang: 'vi' | 'en', mutate?: (o: CoachOutputV1) => void) {
  const ctx = ppContext(fx, lang);
  const out = structuredClone(mockCoachOutput(ctx));
  mutate?.(out);
  const post = postprocess(out, ctx);
  return composeResult({ ...ctx, post, kind: 'standard', model: 'claude-sonnet-5-5', createdAt: CREATED_AT });
}

Deno.test('every synthetic fixture × language × frame mode composes a valid full result', async () => {
  let n = 0;
  for (const name of SYNTHETIC) {
    for (const mode of ['frames', 'pose_only'] as const) {
      const fx = await preparedFixture(name, mode);
      for (const lang of ['vi', 'en'] as const) {
        const { result: r, scores } = composeMock(fx, lang);
        CoachResultV1.parse(r);
        n++;
        assertEquals(r.status, 'succeeded');
        assertEquals(r.access, 'full');
        assertEquals(r.narrativeLanguage, lang);
        assertEquals(r.analysisId, fx.prepared.analysisId);
        assertEquals(r.meta.promptVersion, PROMPT_VERSION);
        assertEquals(r.meta.schemaVersion, COACH_SCHEMA_VERSION);
        assertEquals(r.meta.algoVersion, fx.prepared.algoVersion);
        assert(scores, 'scores');
        assertEquals(r.overall.displayScore, scores.overall.displayScore);
        // The hero is not repeated in weaknesses; the plan starts with the hero's fix.
        if (r.hero) {
          assertFalse(r.weaknesses.some((w) => w.checkpointId === r.hero!.checkpointId), `${name}: hero repeated`);
          assertEquals(r.plan[0]?.faultId ?? null, r.hero.faultId);
          // pose_only still lists the (local, never uploaded) frames for evidence display.
          if (r.hero.frameId) assert(fx.prepared.frameRequests.some((f) => f.frameId === r.hero!.frameId));
        }
        assert(r.plan.length <= 3 && r.strengths.length <= 3);
        // Display scores are multiples of 5; no digits in observations.
        for (const s of r.subScores) if (s.displayScore !== null) assertEquals(s.displayScore % 5, 0);
        const observations = [...r.strengths, ...r.weaknesses].flatMap((f) => f.evidence.map((e) => e.observation));
        assert(observations.every((o) => !/\d/.test(o)), `${name}: digits in an observation`);
        // V checkpoints judged in frames mode, excluded (s null) in pose_only.
        const v = r.checkpoints?.filter((c) => c.assess === 'V') ?? [];
        if (mode === 'pose_only') assert(v.every((c) => c.s === null), `${name}: V scored in pose_only`);
      }
    }
  }
  assertEquals(n, SYNTHETIC.length * 4);
});

Deno.test('injury-flagged candidates become fixed safety notes; a medical hit adds see_professional', async () => {
  const fx = await preparedFixture('synthetic_bd_smash_30');
  const prepared = structuredClone(fx.prepared);
  const flagged = fx.rubric.checkpoints.find((c) =>
    c.injuryFlag && prepared.checkpointTable.some((r) => r.id === c.id)
  );
  assert(flagged, 'the smash table has an injury-flagged checkpoint (SM7)');
  prepared.candidates.injury = [{ checkpointId: flagged.id, s: 0.1, c: 1 }];
  const { result } = composeMock({ prepared, rubric: fx.rubric }, 'en', (o) => {
    o.weaknesses[1].detail = 'Keep going like this and you risk a ligament injury.';
  });
  const kinds = result.safety.map((s) => s.kind);
  assert(kinds.includes('see_professional'));
  const note = result.safety.find((s) => s.checkpointId === flagged.id);
  assertEquals(note?.kind, 'technique_risk');
  assertEquals(note?.message, flagged.safety?.en);
  assertEquals(note?.localized, flagged.safety);
});

Deno.test('rejected result: no scores, rejection tips, still valid', async () => {
  const fx = await preparedFixture('synthetic_pb_serve_30');
  const { result, scores } = composeMock(fx, 'vi', (o) => {
    o.input_check.is_assessable = false;
  });
  CoachResultV1.parse(result);
  assertEquals(result.status, 'rejected');
  assertEquals(result.rejection?.code, 'not_assessable');
  assertEquals(scores, null);
  assertEquals(result.hero, null);
  assertEquals(result.overall.displayScore, null);
});

Deno.test('Claude fixtures compose: hero frame from the best stroke, server numbers in details', async () => {
  const fx = await preparedFixture('synthetic_bd_clear_fh_60');
  const ctx = ppContext(fx, 'vi');
  const out = await loadFixture<CoachOutputV1>('claude/bd_clear_fh_60.vi.json');
  const post = postprocess(out, ctx);
  const { result } = composeResult({
    ...ctx,
    post,
    kind: 'standard',
    model: 'claude-sonnet-5-5',
    createdAt: CREATED_AT,
  });
  assertEquals(result.hero?.checkpointId, 'bd.clear_fh.C5');
  assertEquals(result.hero?.frameId, 'F3'); // contact frame of the best stroke
  const ev = result.weaknesses[0].evidence[0];
  assertNotEquals(ev.detail, null);
  assert(ev.detail!.valueText.length > 0 && ev.detail!.targetText.length > 0);
  // The worst-stroke evidence of the hero points to a local L# frame.
  const heroWeakness = post.status === 'ok' ? post.weaknesses[0] : null;
  assertEquals(heroWeakness?.evidence[1]?.strokeId, 4);
  assertEquals(result.plan[0].drills[0].id, 'bd.drill.hanging_shuttle');
  assertEquals(result.plan[0].target?.metricKey, 'bd.clear_fh.C5');
  // Free-text stays in the narrative language; catalog texts keep both languages.
  assertEquals(result.narrativeLanguage, 'vi');
  assert(result.hero?.cue.vi && result.hero?.cue.en);
});
