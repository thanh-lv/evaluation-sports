import { assert, assertEquals } from '@std/assert';
import { faceDirection, hittingDirection, lateralSign } from '@shared/engine/direction.ts';
import { computePhases } from '@shared/engine/phases.ts';
import { segmentStrokes } from '@shared/engine/segment.ts';
import type { SmoothTrack } from '@shared/engine/types.ts';
import { SYNTHETIC_FIXTURES } from '../../../../scripts/gen-synthetic-pose.ts';
import { LAUNCH_SEGMENT_PARAMS, loadSynthetic, runSignal } from './_pipeline.ts';

Deno.test('hitting direction f matches the generator on every fixture (incl. mirrored and left-handed)', async () => {
  for (const { name, opts } of SYNTHETIC_FIXTURES) {
    const { pose, truth } = await loadSynthetic(name);
    const run = runSignal(pose);
    const seg = segmentStrokes(run.smooth, truth.declared, LAUNCH_SEGMENT_PARAMS[opts.skill]);
    assert(seg.ok);
    const phases = computePhases(run.smooth, seg.strokes, truth.declared);
    const dir = hittingDirection(run.smooth, seg.strokes, truth.declared, phases.map((p) => p.readyWindow));
    assertEquals(dir.f, truth.f, name);
    assertEquals(dir.source, 'wrist', name);
    // The face fallback agrees on its own.
    assertEquals(faceDirection(run.smooth, phases.map((p) => p.readyWindow)), truth.f, name);
  }
});

Deno.test('a weak wrist vote falls back to the face, then to +1', async () => {
  const { pose, truth } = await loadSynthetic('synthetic_bd_clear_fh_30_mirrored');
  const run = runSignal(pose);
  const seg = segmentStrokes(run.smooth, 'right', LAUNCH_SEGMENT_PARAMS['bd.clear_fh']);
  assert(seg.ok);
  const windows = computePhases(run.smooth, seg.strokes, 'right').map((p) => p.readyWindow);
  const still: SmoothTrack = {
    ...run.smooth,
    vel: {
      ...run.smooth.vel,
      rWri: { ...run.smooth.vel.rWri, vx: run.smooth.vel.rWri.vx.map((v) => (v === null ? v : 0)) },
    },
  };
  const face = hittingDirection(still, seg.strokes, 'right', windows);
  assertEquals(face.source, 'face');
  assertEquals(face.f, truth.f);
  assertEquals(face.votes.abstain, seg.strokes.length);
  const none = hittingDirection(still, seg.strokes, 'right', []);
  assertEquals(none, { f: 1, source: 'default', votes: { pos: 0, neg: 0, abstain: seg.strokes.length } });
});

Deno.test('lateral sign h: behind = image-right is player-right; front mirrored; left-handers flip', () => {
  assertEquals(lateralSign('behind', 'right'), 1);
  assertEquals(lateralSign('behind', 'left'), -1);
  assertEquals(lateralSign('front', 'right'), -1);
  assertEquals(lateralSign('front', 'left'), 1);
  assertEquals(lateralSign('diagonal', 'right'), 1);
  assertEquals(lateralSign('side', 'left'), -1);
});
