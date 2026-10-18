import { assert, assertAlmostEquals, assertEquals } from '@std/assert';
import {
  gridIndexAt,
  gridRange,
  leverageAt0,
  localMaxima,
  lowerBound,
  mad,
  median,
  nearestIndex,
  parabolicPeak,
  polyFit,
  prominence,
  quantile,
} from '@shared/engine/signal_util.ts';

Deno.test('median / mad / quantile ignore non-finite values', () => {
  assertEquals(median([3, 1, 2]), 2);
  assertEquals(median([4, 1, 3, 2]), 2.5);
  assert(Number.isNaN(median([])));
  assertEquals(median([1, NaN, 3]), 2);
  assertEquals(mad([1, 2, 3, 4, 100]), 1);
  assertEquals(quantile([0, 10], 0.25), 2.5);
  assertEquals(quantile([5], 0.95), 5);
});

Deno.test('polyFit recovers an exact quadratic and its derivative at 0', () => {
  const ts = [-0.1, -0.06, -0.03, 0.02, 0.05, 0.09];
  const ys = ts.map((t) => 2 - 3 * t + 7 * t * t);
  const f = polyFit(ts, ys, 2);
  assert(f);
  assertAlmostEquals(f[0], 2, 1e-9);
  assertAlmostEquals(f[1], -3, 1e-7);
  assertAlmostEquals(f[2], 7, 1e-5);
  const lin = polyFit([1, 2, 3], [3, 5, 7], 1);
  assert(lin);
  assertAlmostEquals(lin[0], 1, 1e-12);
  assertAlmostEquals(lin[1], 2, 1e-12);
  assertEquals(polyFit([1, 2], [1, 2], 2), null);
  assertEquals(polyFit([1, 1, 1], [1, 2, 3], 1), null);
});

Deno.test('leverageAt0 matches the closed form for symmetric samples', () => {
  // t = ±1, ±2, ±3: (XᵀX)⁻¹₀₀ = s4 / (s0·s4 − s2²) = 196 / (6·196 − 28²) = 0.5
  assertAlmostEquals(leverageAt0([-3, -2, -1, 1, 2, 3], 2), 0.5, 1e-12);
  assertAlmostEquals(leverageAt0([-1, 1], 1), 0.5, 1e-12);
});

Deno.test('time lookups', () => {
  const t = [0, 10, 20, 30];
  assertEquals(lowerBound(t, 15), 2);
  assertEquals(lowerBound(t, 40), 4);
  assertEquals(nearestIndex(t, 14), 1);
  assertEquals(nearestIndex(t, 15), 1);
  assertEquals(nearestIndex(t, -5), 0);
  assertEquals(nearestIndex([], 1), -1);
  const grid = { t0Us: 1000, hz: 30 as const, tUs: [1000, 34333, 67667, 101000] };
  assertEquals(gridIndexAt(grid, 50_000), 1);
  assertEquals(gridIndexAt(grid, 10_000_000), 3);
  assertEquals(gridRange(grid, 34_333, 101_000), [1, 3]);
  assertEquals(gridRange(grid, 40_000, 60_000), null);
});

Deno.test('localMaxima, prominence and parabolic refinement', () => {
  const v = [0, 1, 5, 1, 2, 3, 3, 2, null, 4, 0];
  assertEquals(localMaxima(v), [2, 5]);
  assertEquals(prominence(v, 2), 5); // walks to both ends: higher of the two minima is 0
  assertEquals(prominence(v, 5), 1); // bases: 1 (left, stops at the 5) and 2 (right, stops at the 4)
  // Symmetric samples around a true peak at +0.25 of a sample.
  const f = (x: number) => 10 - (x - 0.25) ** 2;
  const p = parabolicPeak([f(-1), f(0), f(1)], 1);
  assertAlmostEquals(p.delta, 0.25, 1e-12);
  assertAlmostEquals(p.value, 10, 1e-12);
});
