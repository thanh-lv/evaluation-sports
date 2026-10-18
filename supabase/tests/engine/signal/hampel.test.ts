import { assertEquals } from '@std/assert';
import { JOINT_ORDER, PoseV1 } from '@shared/contracts/index.ts';
import { HAMPEL_DEFAULTS, hampelFilter, hampelOutliers } from '@shared/engine/hampel.ts';
import { normalizePose } from '@shared/engine/normalize.ts';
import { rng } from '../../../../scripts/gen-synthetic-pose.ts';
import { generateSyntheticPose } from '../../../../scripts/gen-synthetic-pose.ts';

const T = 0.18; // torso unit in frame heights
const FLOOR = HAMPEL_DEFAULTS.sigmaFloorT * T;

/** A wrist coordinate reversing from −v0 to +v0 T/s with time constant tau (a smoothed V), sampled with VFR jitter. */
function reversal(hz: number, v0: number, tau: number, seed: number): { tUs: number[]; y: number[] } {
  const r = rng(seed);
  const tUs: number[] = [];
  const y: number[] = [];
  for (let i = 0; i < 2 * hz; i++) {
    const t = (i - hz) / hz + (r() - 0.5) * 0.16 / hz;
    tUs.push(Math.round(2e6 + t * 1e6));
    y.push(T * v0 * tau * Math.log(Math.cosh(t / tau)) + T * 0.02 * (r() - 0.5));
  }
  return { tUs, y };
}

Deno.test('Hampel keeps sharp 20–30 T/s reversals (30 and 60 Hz, VFR jitter, noise)', () => {
  for (const hz of [30, 60]) {
    for (const v0 of [20, 25, 30]) {
      for (const tau of [0.01, 0.03, 0.06]) {
        for (let seed = 1; seed <= 4; seed++) {
          const { tUs, y } = reversal(hz, v0, tau, seed);
          assertEquals(hampelOutliers(tUs, y, FLOOR, HAMPEL_DEFAULTS), [], `${hz} Hz, ${v0} T/s, tau ${tau}`);
        }
      }
    }
  }
});

Deno.test('Hampel removes spikes next to (but not inside) a fast reversal', () => {
  for (const hz of [30, 60]) {
    const { tUs, y } = reversal(hz, 25, 0.03, 9);
    const spikes = [Math.round(hz * 0.3), Math.round(hz * 1.5), Math.round(hz * 1.8)];
    const amps = [0.4, -0.6, 1.2];
    spikes.forEach((i, k) => (y[i] += amps[k] * T));
    assertEquals(hampelOutliers(tUs, y, FLOOR, HAMPEL_DEFAULTS), spikes, `${hz} Hz`);
  }
});

Deno.test('Hampel removes a spike right before a dropped-frame gap', () => {
  const tUs: number[] = [];
  const y: number[] = [];
  for (let i = 0; i < 60; i++) {
    if (i >= 31 && i <= 32) continue; // two dropped frames → the sample at 30 has no right neighbour within 100 ms
    tUs.push(1_000_000 + Math.round((i * 1e6) / 30));
    y.push(0.5 + 0.01 * i);
  }
  const at = tUs.indexOf(1_000_000 + 1_000_000);
  y[at] += 0.5 * T;
  assertEquals(hampelOutliers(tUs, y, FLOOR, HAMPEL_DEFAULTS), [at]);
});

Deno.test('Hampel on synthetic clips: removes exactly the injected spikes, never real swing samples', () => {
  for (const skill of ['bd.smash', 'bd.clear_fh', 'pb.serve', 'pb.dink'] as const) {
    for (const hz of [30, 60] as const) {
      for (const peakSpeedTps of skill.startsWith('bd.') ? [20, 30] : [undefined]) {
        const { pose, truth } = generateSyntheticPose({ skill, hz, seed: 11, peakSpeedTps, dropouts: false });
        const raw = normalizePose(PoseV1.parse(pose));
        const { track, removed } = hampelFilter(raw);
        const got: string[] = [];
        for (const j of JOINT_ORDER) {
          for (let i = 0; i < raw.tUs.length; i++) {
            if (raw.joints[j].x[i] !== null && track.joints[j].x[i] === null) got.push(`${j}@${i}`);
          }
        }
        const want = truth.spikes.map((s) => `${s.joint}@${s.index}`);
        assertEquals(got.sort(), want.sort(), `${skill} @${hz} Hz peak ${peakSpeedTps}`);
        assertEquals(removed, want.length);
      }
    }
  }
});

Deno.test('Hampel does not mutate its input', () => {
  const raw = normalizePose(PoseV1.parse(generateSyntheticPose({ skill: 'pb.serve', hz: 30, seed: 2 }).pose));
  const before = structuredClone(raw.joints);
  hampelFilter(raw);
  assertEquals(raw.joints, before);
});
