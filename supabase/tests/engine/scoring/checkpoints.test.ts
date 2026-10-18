/**
 * Checkpoint table on hand-built tracks with the real rubric (DESIGN.md §6.2 steps 10–11, §6.4): view factors
 * (front = behind column), exclusion, quality gate, few-stroke halving, 30 Hz velocity halving, text formatting and
 * left-handed joint mirroring.
 */
import { assert, assertEquals } from '@std/assert';
import type { ConfirmedCameraView, Handedness } from '@shared/contracts/index.ts';
import { evaluateCheckpoints, formatValue, mirrorJoints, targetText } from '@shared/engine/checkpoints.ts';
import { buildMetricContext } from '@shared/engine/metrics.ts';
import type { CheckpointRow } from '@shared/engine/prepared_state.ts';
import type { AnalysisHz, StrokePhases } from '@shared/engine/types.ts';
import { loadRubric } from '@shared/rubric/load.ts';
import { phasesAt, standing, trackFrom } from './_track.ts';

const rubric = loadRubric('badminton');
const clear = rubric.skills.find((s) => s.id === 'bd.clear_fh')!;

function table(o: {
  view?: ConfirmedCameraView;
  handedness?: Handedness;
  strokes?: number;
  quality?: number[];
  excluded?: number[];
  hz?: AnalysisHz;
}): CheckpointRow[] {
  const n = o.strokes ?? 3;
  const hz = o.hz ?? 60;
  const track = trackFrom(() => standing(), { durationS: 3 * n + 1, hz });
  const phases: StrokePhases[] = Array.from({ length: n }, (_, k) =>
    phasesAt(track, {
      ready: 3 * k + 1,
      bsEnd: 3 * k + 1.8,
      contact: 3 * k + 2,
      ftStop: 3 * k + 2.3,
      recovery: 3 * k + 3,
      swingStart: 3 * k + 1.5,
    }, k + 1));
  const view = o.view ?? 'side';
  const handedness = o.handedness ?? 'right';
  const ctx = buildMetricContext({ track, handedness, view, f: 1, mirrored: false, strokes: phases });
  return evaluateCheckpoints({
    skill: clear,
    checkpoints: rubric.checkpoints,
    ctx,
    phases,
    hz,
    view,
    quality: new Map(phases.map((p, i) => [p.strokeId, o.quality?.[i] ?? 0.9])),
    excluded: new Set(o.excluded ?? []),
  });
}

const byId = (rows: CheckpointRow[], suffix: string) => rows.find((r) => r.id.endsWith(suffix))!;

Deno.test('every skill checkpoint gets a row in rubric order with the right status per assess tag', () => {
  const rows = table({});
  assertEquals(rows.map((r) => r.id), clear.checkpoints);
  for (const r of rows) {
    if (r.assess === 'N') assertEquals(r.status, 'not_assessable');
    else if (r.assess === 'V') assertEquals([r.status, r.s, r.perStroke.length], ['visual', null, 0]);
    else assert(['measured', 'view_excluded', 'no_data'].includes(r.status), `${r.id} ${r.status}`);
    if (r.status === 'measured') assertEquals(r.perStroke.length, 3);
  }
});

Deno.test('view factors: a 0 factor excludes; front uses the behind column', () => {
  const side = table({ view: 'side' });
  assertEquals(byId(side, 'ready.R1').status, 'view_excluded'); // stanceW S:0
  const behind = table({ view: 'behind' });
  const front = table({ view: 'front' });
  assertEquals(byId(behind, 'ready.R1').status, 'measured');
  assertEquals(byId(front, 'ready.R1').viewFactor, byId(behind, 'ready.R1').viewFactor);
  assertEquals(byId(behind, 'clear_fh.C6').status, 'view_excluded'); // wristFwd B:0
  // D factor 0.6 scales c.
  const diag = table({ view: 'diagonal' });
  const r2 = byId(diag, 'ready.R2');
  assertEquals([r2.viewFactor, r2.c], [0.6, 0.6]);
});

Deno.test('excluded strokes and low-quality strokes stay listed but do not aggregate', () => {
  const rows = table({ excluded: [2], quality: [0.9, 0.9, 0.3] });
  const r2 = byId(rows, 'ready.R2');
  assertEquals(r2.perStroke.map((p) => p.used), [true, false, false]);
  assertEquals(r2.validStrokes, 1);
  assertEquals(r2.c, 0.5, 'one valid stroke → confidence halved');
  // No stroke passes the gate: the gate is dropped.
  const low = byId(table({ quality: [0.3, 0.3, 0.3] }), 'ready.R2');
  assertEquals([low.validStrokes, low.c], [3, 1]);
});

Deno.test('velocity-based checkpoints are halved at 30 Hz', () => {
  const hop60 = byId(table({ hz: 60 }), 'split.S1');
  const hop30 = byId(table({ hz: 30 }), 'split.S1');
  assert(hop60.velocityBased);
  assertEquals(hop30.c, hop60.c / 2);
});

Deno.test('value/target text and reading', () => {
  const rows = table({});
  const r2 = byId(rows, 'ready.R2'); // kneeFlex 15–45°, straight legs → 0°
  assertEquals([r2.valueText, r2.targetText, r2.reading], ['0°', '15–45°', 'low']);
  const hop = byId(rows, 'split.S1'); // standing still: no split step
  assertEquals([hop.valueText, hop.targetText, hop.value, hop.reading, hop.s], ['0/3', '✓', false, 'false', 0]);
  assertEquals(formatValue(0.456, 'T'), '0.46 T');
  assertEquals(formatValue(3.21, 'T/s'), '3.2 T/s');
  assertEquals(formatValue(0.5, 'ratio'), '0.50');
  assertEquals(targetText({ fn: 'wristH', target: [null, 0.3], tol: 1, unit: 'T' }), '≤ 0.30 T');
  assertEquals(targetText({ fn: 'elbowAng', target: [150, null], tol: 1, unit: 'deg' }), '≥ 150°');
  assertEquals(targetText({ fn: 'wristH', target: [0.5, 1.3], tol: 1, unit: 'T' }), '0.50–1.30 T');
});

Deno.test('joints are mirrored for left-handed players', () => {
  assertEquals(mirrorJoints(['rSho', 'rElb', 'neck', 'lAnk'], true), ['lSho', 'lElb', 'neck', 'rAnk']);
  const rows = table({ handedness: 'left' });
  const c5 = byId(rows, 'clear_fh.C5');
  const def = rubric.checkpoints.find((c) => c.id === c5.id)!;
  assertEquals(c5.joints, mirrorJoints(def.joints, true));
});
