import { assert } from '@std/assert';
import { CleanTrackV1, isInterpolated, JOINT_ORDER, PoseV1 } from '@shared/contracts/index.ts';
import { loadFixture } from '../_helpers/fixtures.ts';

/** Builds a tiny clean track from the minimal pose (the engine produces the real one). */
async function sampleTrack() {
  const pose = PoseV1.parse(await loadFixture('pose/synthetic_minimal.json'));
  const hz = pose.video.analysisHz as 30 | 60;
  const t0 = pose.track.tUs[0];
  const n = 10;
  return {
    schema: 'clean-track.v1',
    analysisId: pose.analysisId,
    algoVersion: 'test',
    analysisHz: hz,
    display: pose.video.display,
    mirrored: false,
    torsoT: 0.19,
    jointOrder: [...JOINT_ORDER],
    t0Us: t0,
    tUs: Array.from({ length: n }, (_, i) => t0 + Math.round((i * 1e6) / hz)),
    kp: pose.track.kp.slice(0, n).map((row) => row.map((v) => v + 0.5 * (v > 0 && v < 1000 ? 1 : 0))),
    interp: Array.from({ length: n }, (_, i) => (i === 3 ? 1 << 10 : 0)),
    strokes: [{
      id: 1,
      tStartUs: t0,
      tContactUs: t0 + 100_000,
      contactIsEstimate: true,
      tEndUs: t0 + 200_000,
      phases: {
        swingStart: null,
        ready: t0,
        bsEnd: t0 + 50_000,
        contact: t0 + 100_000,
        ftStop: t0 + 150_000,
        recovery: null,
      },
      role: 'best',
      excluded: false,
    }],
  };
}

Deno.test('clean track contract', async () => {
  const track = await sampleTrack();
  const r = CleanTrackV1.safeParse(track);
  assert(r.success, r.success ? '' : JSON.stringify(r.error.issues));
  assert(isInterpolated(track.interp[3], 10));
  assert(!isInterpolated(track.interp[3], 11));
});

Deno.test('clean track rejects a non-uniform grid and length mismatch', async () => {
  const a = await sampleTrack();
  a.tUs[5] += 1;
  assert(!CleanTrackV1.safeParse(a).success);
  const b = await sampleTrack();
  b.interp.pop();
  assert(!CleanTrackV1.safeParse(b).success);
});
