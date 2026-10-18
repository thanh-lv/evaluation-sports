import { assert, assertEquals } from '@std/assert';
import { PoseV1 } from '@shared/contracts/index.ts';
import { checkHandedness, offWrist, racketWrist } from '@shared/engine/handedness.ts';
import { hampelFilter } from '@shared/engine/hampel.ts';
import { normalizePose } from '@shared/engine/normalize.ts';
import { resampleTrack } from '@shared/engine/resample.ts';
import { smoothTrack } from '@shared/engine/savgol.ts';
import { generateSyntheticPose } from '../../../../scripts/gen-synthetic-pose.ts';
import { loadSynthetic, runSignal } from './_pipeline.ts';

Deno.test('wrist helpers', () => {
  assertEquals(racketWrist('right'), 'rWri');
  assertEquals(racketWrist('left'), 'lWri');
  assertEquals(offWrist('right'), 'lWri');
});

Deno.test('handedness: matching profile → no suggestion on every fixture', async () => {
  for (
    const name of [
      'synthetic_bd_clear_fh_60',
      'synthetic_bd_smash_30',
      'synthetic_pb_serve_30',
      'synthetic_pb_dink_60',
      'synthetic_bd_clear_fh_30_mirrored',
      'synthetic_pb_dink_30_left',
    ]
  ) {
    const { pose, truth } = await loadSynthetic(name);
    const run = runSignal(pose);
    const res = checkHandedness(run.smooth, truth.declared);
    assertEquals(res.suggestion, null, name);
    assert(res.peaks.length <= 5);
    assertEquals(res.peaks[0].wrist, racketWrist(truth.playsWith), name);
  }
});

Deno.test('handedness: a left-hander profiled as right-handed → suggestion "left" (and vice versa)', () => {
  for (const skill of ['bd.clear_fh', 'bd.smash', 'pb.serve', 'pb.dink', 'pb.drop3'] as const) {
    for (const hz of [30, 60] as const) {
      const lefty = generateSyntheticPose({ skill, hz, seed: 31, playsWith: 'left', declared: 'right' });
      assertEquals(checkHandedness(runSignal(lefty.pose).smooth, 'right').suggestion, 'left', `${skill} @${hz}`);
      const righty = generateSyntheticPose({ skill, hz, seed: 32, playsWith: 'right', declared: 'left' });
      assertEquals(checkHandedness(runSignal(righty.pose).smooth, 'left').suggestion, 'right', `${skill} @${hz}`);
    }
  }
});

Deno.test('handedness: skipping the mirrored swap would make a right-hander look left-handed', async () => {
  const { pose } = await loadSynthetic('synthetic_bd_clear_fh_30_mirrored');
  const p = PoseV1.parse(pose);
  const noSwap = smoothTrack(resampleTrack(hampelFilter(normalizePose(p)).track, 30));
  assertEquals(checkHandedness(noSwap, 'right').suggestion, 'left');
  assertEquals(checkHandedness(runSignal(pose).smooth, 'right').suggestion, null);
});
