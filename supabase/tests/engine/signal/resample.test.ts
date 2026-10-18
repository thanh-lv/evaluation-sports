import { assert, assertAlmostEquals, assertEquals } from '@std/assert';
import { FLAG_COASTED, FLAG_REACQUIRED, isInterpolated, JOINT_INDEX } from '@shared/contracts/index.ts';
import { hermite, HERMITE_FILL_CONF, LINEAR_FILL_CONF, resampleTrack, uniformGrid } from '@shared/engine/resample.ts';
import { mapJoints } from '@shared/engine/signal_util.ts';
import type { RawTrack } from '@shared/engine/types.ts';

const W = JOINT_INDEX.rWri;

/** A raw track at `hz` (jittered by `jitterUs`) whose rWri x follows `fx(tS)`, all other joints still. */
function rawTrack(hz: number, n: number, fx: (tS: number) => number, jitterUs = 0): RawTrack {
  const tUs = Array.from({ length: n }, (_, i) => 500_000 + Math.round((i * 1e6) / hz) + (i % 2 ? jitterUs : 0));
  const joints = mapJoints((j) => ({
    x: tUs.map((t) => (j === 'rWri' ? fx(t / 1e6) : 0.5)),
    y: tUs.map(() => 0.4),
    c: tUs.map(() => 0.9),
  }));
  return {
    tUs,
    joints,
    flags: tUs.map(() => 0),
    bboxCfs: tUs.map(() => [0, 0, 10, 10]),
    aspect: 16 / 9,
    display: { w: 1920, h: 1080 },
    torsoT: 0.2,
    mirrored: false,
    mirrorSwapApplied: false,
  };
}

function drop(track: RawTrack, from: number, to: number): void {
  for (let i = from; i <= to; i++) {
    track.joints.rWri.x[i] = null;
    track.joints.rWri.y[i] = null;
    track.joints.rWri.c[i] = 0;
  }
}

Deno.test('uniform grid matches the clean-track contract tUs[i] = t0 + round(i·1e6/hz)', () => {
  const g = uniformGrid(1_000_000, 1_100_000, 30);
  assertEquals(g, [1_000_000, 1_033_333, 1_066_667, 1_100_000]);
  const raw = rawTrack(60, 120, () => 0.5, 3000);
  const grid = resampleTrack(raw, 60);
  grid.tUs.forEach((t, i) => assertEquals(t, grid.t0Us + Math.round((i * 1e6) / 60)));
  assertEquals(grid.t0Us, raw.tUs[0]);
  assert(grid.tUs[grid.tUs.length - 1] <= raw.tUs[raw.tUs.length - 1]);
});

Deno.test('VFR samples without gaps are interpolated linearly and not marked interp', () => {
  const raw = rawTrack(30, 60, (t) => 2 * t, 4000);
  const grid = resampleTrack(raw, 30);
  for (let i = 0; i < grid.tUs.length; i++) {
    assertAlmostEquals(grid.joints.rWri.x[i] as number, (2 * grid.tUs[i]) / 1e6, 1e-9);
    assertEquals(grid.interp[i], 0);
  }
});

Deno.test('gaps ≤ 100 ms: linear fill, interp bit set, confidence scaled', () => {
  const raw = rawTrack(30, 60, (t) => 3 * t);
  drop(raw, 20, 21); // span 100 ms between samples 19 and 22
  const grid = resampleTrack(raw, 30);
  for (const i of [20, 21]) {
    assertAlmostEquals(grid.joints.rWri.x[i] as number, (3 * grid.tUs[i]) / 1e6, 1e-9);
    assert(isInterpolated(grid.interp[i], W));
    assertAlmostEquals(grid.joints.rWri.c[i], 0.9 * LINEAR_FILL_CONF, 1e-12);
  }
  assert(!isInterpolated(grid.interp[19], W) && !isInterpolated(grid.interp[22], W));
  assert(!isInterpolated(grid.interp[20], JOINT_INDEX.lWri));
});

Deno.test('gaps ≤ 200 ms with good ends: cubic Hermite; longer or bad ends: null', () => {
  const f = (t: number) => 0.4 + 0.5 * t; // linear motion → Hermite with difference tangents is exact
  const raw = rawTrack(30, 90, f);
  drop(raw, 20, 24); // span 6 frames = 200 ms
  drop(raw, 50, 56); // span 8 frames ≈ 267 ms → null
  drop(raw, 1, 4); // span 167 ms but no good left end (sample 0 has no left neighbour) → null
  const grid = resampleTrack(raw, 30);
  for (let i = 20; i <= 24; i++) {
    assertAlmostEquals(grid.joints.rWri.x[i] as number, f(grid.tUs[i] / 1e6), 1e-9);
    assert(isInterpolated(grid.interp[i], W));
    assertAlmostEquals(grid.joints.rWri.c[i], 0.9 * HERMITE_FILL_CONF, 1e-12);
  }
  for (let i = 50; i <= 56; i++) assertEquals(grid.joints.rWri.x[i], null);
  for (let i = 1; i <= 4; i++) assertEquals(grid.joints.rWri.x[i], null);
  assertEquals(grid.joints.rWri.c[52], 0);
});

Deno.test('dropped frames (PTS jumps) count as gaps', () => {
  const raw = rawTrack(30, 60, (t) => t);
  // Remove frames 30..33 from the timeline entirely (a 167 ms PTS jump).
  const keep = raw.tUs.map((_, i) => i < 30 || i > 33);
  const pick = <T>(a: T[]) => a.filter((_, i) => keep[i]);
  const jumped: RawTrack = {
    ...raw,
    tUs: pick(raw.tUs),
    flags: pick(raw.flags),
    bboxCfs: pick(raw.bboxCfs),
    joints: mapJoints((j) => ({
      x: pick(raw.joints[j].x),
      y: pick(raw.joints[j].y),
      c: pick(raw.joints[j].c),
    })),
  };
  const grid = resampleTrack(jumped, 30);
  for (let i = 30; i <= 33; i++) {
    assert(isInterpolated(grid.interp[i], W));
    assertAlmostEquals(grid.joints.rWri.x[i] as number, grid.tUs[i] / 1e6, 1e-9);
  }
  assertEquals(grid.interp[29], 0);
});

Deno.test('tracker flags land on the nearest grid sample', () => {
  const raw = rawTrack(60, 60, () => 0.5, 2000);
  raw.flags[10] = FLAG_REACQUIRED;
  raw.flags[11] = FLAG_COASTED;
  const grid = resampleTrack(raw, 60);
  assertEquals(grid.flags[10], FLAG_REACQUIRED);
  assertEquals(grid.flags[11], FLAG_COASTED);
  assertEquals(grid.flags.filter((f) => f !== 0).length, 2);
});

Deno.test('hermite basis interpolates end values and tangents', () => {
  assertEquals(hermite(1, 3, 0, 0, 0), 1);
  assertEquals(hermite(1, 3, 0, 0, 1), 3);
  assertAlmostEquals(hermite(0, 1, 1, 1, 0.5), 0.5, 1e-12);
});
