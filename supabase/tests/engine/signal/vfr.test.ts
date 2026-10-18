import { assert, assertEquals } from '@std/assert';
import { segmentStrokes } from '@shared/engine/segment.ts';
import { generateSyntheticPose, LAUNCH_SKILLS } from '../../../../scripts/gen-synthetic-pose.ts';
import { LAUNCH_SEGMENT_PARAMS, runSignal } from './_pipeline.ts';

/**
 * Same motion sampled two ways: a uniform grid, and VFR (±8 % jitter plus 1–3 dropped frames now and then).
 * After resampling + SG the racket-wrist peak speeds must agree within 5 % (DESIGN.md D5/D6).
 */
Deno.test('VFR timestamps: peak wrist speeds within 5 % of the uniform-sampling run', () => {
  for (const skill of LAUNCH_SKILLS) {
    for (const hz of [30, 60] as const) {
      const base = { skill, hz, seed: 71, noiseCfs: 0, dropouts: false, spikes: false };
      const uniform = runSignal(generateSyntheticPose({ ...base, vfr: false }).pose);
      const vfr = runSignal(generateSyntheticPose({ ...base, vfr: true }).pose);
      assert(vfr.pose.track.tUs.length < uniform.pose.track.tUs.length, 'VFR run should drop frames');
      const params = LAUNCH_SEGMENT_PARAMS[skill];
      const su = segmentStrokes(uniform.smooth, 'right', params);
      const sv = segmentStrokes(vfr.smooth, 'right', params);
      assert(su.ok && sv.ok);
      assertEquals(sv.strokes.length, su.strokes.length, `${skill} @${hz}`);
      su.strokes.forEach((s, k) => {
        const ratio = sv.strokes[k].vPeak / s.vPeak;
        assert(Math.abs(ratio - 1) <= 0.05, `${skill} @${hz} stroke ${s.id}: ratio ${ratio.toFixed(3)}`);
        assert(Math.abs(sv.strokes[k].tPeakUs - s.tPeakUs) <= 1e6 / hz, `${skill} @${hz} stroke ${s.id} timing`);
      });
      // The whole speed curve, not only the peaks: mean |Δv| relative to the peak stays small.
      const vu = uniform.smooth.vel.rWri.speed;
      const vv = vfr.smooth.vel.rWri.speed;
      let sum = 0, n = 0;
      for (let i = 0; i < Math.min(vu.length, vv.length); i++) {
        if (vu[i] === null || vv[i] === null) continue;
        sum += Math.abs((vu[i] as number) - (vv[i] as number));
        n++;
      }
      const peak = Math.max(...su.strokes.map((s) => s.vPeak));
      assert(sum / n / peak < 0.02, `${skill} @${hz}: mean |Δv| ${(sum / n).toFixed(3)} T/s`);
    }
  }
});
