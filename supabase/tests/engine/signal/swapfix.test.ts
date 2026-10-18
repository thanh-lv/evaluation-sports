import { assert, assertEquals } from '@std/assert';
import { PoseV1 } from '@shared/contracts/index.ts';
import { normalizePose } from '@shared/engine/normalize.ts';
import { segmentStrokes } from '@shared/engine/segment.ts';
import { applyMirrorSwap, fixLimbSwaps } from '@shared/engine/swapfix.ts';
import { generateSyntheticPose } from '../../../../scripts/gen-synthetic-pose.ts';
import { LAUNCH_SEGMENT_PARAMS, runSignal } from './_pipeline.ts';

const opts = { skill: 'bd.clear_fh' as const, hz: 30 as const, seed: 21 };

Deno.test('mirrored source: all L/R labels swapped exactly once', () => {
  const mirrored = normalizePose(PoseV1.parse(generateSyntheticPose({ ...opts, mirrored: true }).pose));
  // A left-hander filmed normally produces the identical image, but keeps its labels.
  const lefty = normalizePose(PoseV1.parse(generateSyntheticPose({ ...opts, playsWith: 'left' }).pose));
  assertEquals(mirrored.joints.lWri, lefty.joints.lWri);

  const once = applyMirrorSwap(mirrored);
  assert(once.mirrorSwapApplied);
  assertEquals(once.joints.rWri, lefty.joints.lWri);
  assertEquals(once.joints.lWri, lefty.joints.rWri);
  assertEquals(once.joints.lEar, lefty.joints.rEar);
  assertEquals(once.joints.nose, lefty.joints.nose);
  // Never a second time, and unmirrored sources are untouched.
  assertEquals(applyMirrorSwap(once), once);
  assertEquals(applyMirrorSwap(lefty), lefty);
  // The input is not mutated.
  assertEquals(mirrored.joints.lWri, lefty.joints.lWri);
  // And the per-chain fix does not undo it.
  assertEquals(fixLimbSwaps(once).swaps, 0);
});

Deno.test('mirrored source: after the swap the right-handed racket wrist drives segmentation', () => {
  const { pose, truth } = generateSyntheticPose({ ...opts, mirrored: true });
  const run = runSignal(pose);
  const seg = segmentStrokes(run.smooth, 'right', LAUNCH_SEGMENT_PARAMS['bd.clear_fh']);
  assert(seg.ok);
  assertEquals(seg.strokes.length, truth.contactsUs.length);
});

Deno.test('limb-chain swap fix restores a transient L/R arm flip', () => {
  const { pose } = generateSyntheticPose({ ...opts, noiseCfs: 0, dropouts: false, spikes: false, vfr: false });
  const clean = normalizePose(PoseV1.parse(pose));
  assertEquals(fixLimbSwaps(clean).swaps, 0);

  const broken = structuredClone(clean);
  const flipped = [40, 41, 42];
  for (const i of flipped) {
    for (const [l, r] of [['lSho', 'rSho'], ['lElb', 'rElb'], ['lWri', 'rWri']] as const) {
      for (const key of ['x', 'y', 'c'] as const) {
        const a = broken.joints[l][key][i];
        broken.joints[l][key][i] = broken.joints[r][key][i] as number;
        broken.joints[r][key][i] = a as number;
      }
    }
  }
  const fixed = fixLimbSwaps(broken);
  assertEquals(fixed.swaps, flipped.length);
  assertEquals(fixed.track.joints.rWri, clean.joints.rWri);
  assertEquals(fixed.track.joints.lElb, clean.joints.lElb);
  assertEquals(fixed.track.joints.lAnk, clean.joints.lAnk); // legs untouched
});

Deno.test('limb-chain swap fix makes no swaps on the synthetic fixtures', () => {
  for (const skill of ['bd.smash', 'pb.serve', 'pb.dink'] as const) {
    for (const hz of [30, 60] as const) {
      const run = runSignal(generateSyntheticPose({ skill, hz, seed: 5 }).pose);
      assertEquals(run.swaps, 0, `${skill} @${hz}`);
    }
  }
});
