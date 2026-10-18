import { assert, assertAlmostEquals, assertEquals } from '@std/assert';
import { sgFilter, sgKernels, sgWindowFor, smoothTrack } from '@shared/engine/savgol.ts';
import { resampleTrack } from '@shared/engine/resample.ts';
import { mapJoints } from '@shared/engine/signal_util.ts';
import type { RawTrack } from '@shared/engine/types.ts';

Deno.test('SG windows and kernels (order 2)', () => {
  assertEquals(sgWindowFor(30), 5);
  assertEquals(sgWindowFor(60), 9);
  const k5 = sgKernels(2);
  [-3, 12, 17, 12, -3].forEach((c, i) => assertAlmostEquals(k5.smooth[i], c / 35, 1e-12));
  [-2, -1, 0, 1, 2].forEach((c, i) => assertAlmostEquals(k5.deriv[i], c / 10, 1e-12));
  const k9 = sgKernels(4);
  [-21, 14, 39, 54, 59, 54, 39, 14, -21].forEach((c, i) => assertAlmostEquals(k9.smooth[i], c / 231, 1e-12));
  assertAlmostEquals(k9.smooth.reduce((a, b) => a + b, 0), 1, 1e-12);
});

Deno.test('SG preserves quadratics exactly (values and derivatives), including edges and gap borders', () => {
  for (const hz of [30, 60] as const) {
    const dt = 1 / hz;
    const f = (t: number) => 0.3 + 1.5 * t - 4 * t * t;
    const df = (t: number) => 1.5 - 8 * t;
    const s: (number | null)[] = Array.from({ length: 40 }, (_, i) => f(i * dt));
    s[20] = null;
    const { value, slope } = sgFilter(s, sgWindowFor(hz), dt);
    for (let i = 0; i < 40; i++) {
      if (i === 20) {
        assertEquals(value[i], null); // never extrapolated into a gap
        assertEquals(slope[i], null);
        continue;
      }
      assertAlmostEquals(value[i] as number, f(i * dt), 1e-9);
      assertAlmostEquals(slope[i] as number, df(i * dt), 1e-6);
    }
  }
});

Deno.test('SG is zero-phase: a symmetric pulse keeps its peak time', () => {
  const s = Array.from({ length: 61 }, (_, i) => Math.exp(-(((i - 30) / 4) ** 2)));
  const { value } = sgFilter(s, 9, 1 / 60);
  const peak = value.indexOf(Math.max(...(value as number[])));
  assertEquals(peak, 30);
});

Deno.test('smoothTrack velocities are SG derivatives in T/s', () => {
  const hz = 60;
  const tUs = Array.from({ length: 120 }, (_, i) => Math.round((i * 1e6) / hz));
  const T = 0.2;
  const raw: RawTrack = {
    tUs,
    joints: mapJoints((j) => ({
      x: tUs.map((t) => (j === 'rWri' ? 0.5 + 3 * T * (t / 1e6) : 0.5)), // 3 T/s to the right
      y: tUs.map((t) => (j === 'rWri' ? 0.4 - 4 * T * (t / 1e6) : 0.4)), // 4 T/s down
      c: tUs.map(() => 0.9),
    })),
    flags: tUs.map(() => 0),
    bboxCfs: tUs.map(() => [0, 0, 1, 1]),
    aspect: 16 / 9,
    display: { w: 1920, h: 1080 },
    torsoT: T,
    mirrored: false,
    mirrorSwapApplied: false,
  };
  const smooth = smoothTrack(resampleTrack(raw, hz));
  assertEquals(smooth.sgWindow, 9);
  for (let i = 0; i < smooth.tUs.length; i++) {
    // Grid PTS are rounded to whole µs, so the constant-dt SG derivative is exact only to ~1e-5.
    assertAlmostEquals(smooth.vel.rWri.vx[i] as number, 3, 1e-3);
    assertAlmostEquals(smooth.vel.rWri.vy[i] as number, -4, 1e-3);
    assertAlmostEquals(smooth.vel.rWri.speed[i] as number, 5, 1e-3);
    assertAlmostEquals(smooth.vel.lWri.speed[i] as number, 0, 1e-9);
  }
  assert(smooth.raw === raw);
});
