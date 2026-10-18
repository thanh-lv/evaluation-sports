/**
 * Small numeric helpers shared by the signal stages: robust statistics, local polynomial fits, time-index lookups
 * and joint-map construction. Pure; no Deno APIs.
 */
import { type Joint, JOINT_ORDER } from '../contracts/common.ts';
import type { GridTrack, JointMap, JointSeries, RawTrack, Series } from './types.ts';

/** Median of the finite values (NaN when empty). Does not mutate the input. */
export function median(values: readonly number[]): number {
  const a = values.filter(Number.isFinite).sort((p, q) => p - q);
  const n = a.length;
  if (n === 0) return NaN;
  return n % 2 === 1 ? a[(n - 1) / 2] : 0.5 * (a[n / 2 - 1] + a[n / 2]);
}

/** Median absolute deviation from the median (unscaled; multiply by 1.4826 for a Gaussian σ). */
export function mad(values: readonly number[]): number {
  const m = median(values);
  return median(values.map((v) => Math.abs(v - m)));
}

/** Linear-interpolated quantile q ∈ [0,1] of the finite values (NaN when empty). */
export function quantile(values: readonly number[], q: number): number {
  const a = values.filter(Number.isFinite).sort((p, r) => p - r);
  if (a.length === 0) return NaN;
  const pos = clamp(q, 0, 1) * (a.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

/** Clamp v into [lo, hi]. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Non-null values of a series. */
export function present(series: Series): number[] {
  const out: number[] = [];
  for (const v of series) if (v !== null) out.push(v);
  return out;
}

/**
 * Least-squares polynomial fit of order ≤ 2 to (t, y). Callers pass times relative to the point of interest, so
 * `[a0, a1, a2]` are the value, first derivative and half the second derivative there. Null when singular.
 */
export function polyFit(
  ts: readonly number[],
  ys: readonly number[],
  order: 0 | 1 | 2,
): [number, number, number] | null {
  const n = ts.length;
  if (n < order + 1) return null;
  if (order === 0) {
    let s = 0;
    for (const y of ys) s += y;
    return [s / n, 0, 0];
  }
  // Normal equations Σ t^(i+j) a_j = Σ t^i y, solved by Cramer's rule (2x2 or 3x3).
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, b0 = 0, b1 = 0, b2 = 0;
  for (let k = 0; k < n; k++) {
    const t = ts[k];
    const y = ys[k];
    const t2 = t * t;
    s0 += 1;
    s1 += t;
    s2 += t2;
    s3 += t2 * t;
    s4 += t2 * t2;
    b0 += y;
    b1 += t * y;
    b2 += t2 * y;
  }
  if (order === 1) {
    const det = s0 * s2 - s1 * s1;
    if (Math.abs(det) <= 1e-12 * s0 * s2) return null;
    return [(b0 * s2 - b1 * s1) / det, (s0 * b1 - s1 * b0) / det, 0];
  }
  const det = s0 * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2);
  if (Math.abs(det) <= 1e-12 * s0 * s2 * s4) return null;
  const a0 = (b0 * (s2 * s4 - s3 * s3) - s1 * (b1 * s4 - s3 * b2) + s2 * (b1 * s3 - s2 * b2)) / det;
  const a1 = (s0 * (b1 * s4 - b2 * s3) - b0 * (s1 * s4 - s3 * s2) + s2 * (s1 * b2 - b1 * s2)) / det;
  const a2 = (s0 * (s2 * b2 - s3 * b1) - s1 * (s1 * b2 - s2 * b1) + b0 * (s1 * s3 - s2 * s2)) / det;
  return [a0, a1, a2];
}

/** Index of the first element ≥ x in a sorted array (array length when none). */
export function lowerBound(sorted: readonly number[], x: number): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index of the element of a sorted array nearest to x (ties → earlier); -1 for an empty array. */
export function nearestIndex(sorted: readonly number[], x: number): number {
  const n = sorted.length;
  if (n === 0) return -1;
  const i = lowerBound(sorted, x);
  if (i <= 0) return 0;
  if (i >= n) return n - 1;
  return x - sorted[i - 1] <= sorted[i] - x ? i - 1 : i;
}

/** Nearest grid index for a time in µs, clamped into the grid. */
export function gridIndexAt(track: Pick<GridTrack, 't0Us' | 'hz' | 'tUs'>, tUs: number): number {
  return clamp(Math.round(((tUs - track.t0Us) * track.hz) / 1e6), 0, track.tUs.length - 1);
}

/** Inclusive grid index range covering [startUs, endUs] ∩ track; null when empty. */
export function gridRange(
  track: Pick<GridTrack, 't0Us' | 'hz' | 'tUs'>,
  startUs: number,
  endUs: number,
): [number, number] | null {
  const n = track.tUs.length;
  const a = Math.max(0, Math.ceil(((startUs - track.t0Us) * track.hz) / 1e6 - 1e-9));
  const b = Math.min(n - 1, Math.floor(((endUs - track.t0Us) * track.hz) / 1e6 + 1e-9));
  return a <= b ? [a, b] : null;
}

/** Build a JointMap by calling `make` for every joint in JOINT_ORDER. */
export function mapJoints<T>(make: (joint: Joint, index: number) => T): JointMap<T> {
  const out = {} as JointMap<T>;
  JOINT_ORDER.forEach((j, i) => {
    out[j] = make(j, i);
  });
  return out;
}

/** Deep copy of a joint series. */
export function cloneSeries(s: JointSeries): JointSeries {
  return { x: s.x.slice(), y: s.y.slice(), c: s.c.slice() };
}

/** Shallow track copy with deep-copied joint arrays (stages never mutate their input). */
export function cloneRawTrack(track: RawTrack): RawTrack {
  return { ...track, joints: mapJoints((j) => cloneSeries(track.joints[j])) };
}

/** True when the joint has a position at sample i. */
export function isPresent(s: JointSeries, i: number): boolean {
  return s.x[i] !== null && s.y[i] !== null;
}

/** L/R joint pairs (left label, right label), used by the mirror swap and the limb-chain swap fix. */
export const LR_PAIRS: readonly (readonly [Joint, Joint])[] = [
  ['lEye', 'rEye'],
  ['lEar', 'rEar'],
  ['lSho', 'rSho'],
  ['lElb', 'rElb'],
  ['lWri', 'rWri'],
  ['lHip', 'rHip'],
  ['lKne', 'rKne'],
  ['lAnk', 'rAnk'],
];

/** Median sampling interval of a strictly increasing µs array (NaN with < 2 samples). */
export function medianIntervalUs(tUs: readonly number[]): number {
  const d: number[] = [];
  for (let i = 1; i < tUs.length; i++) d.push(tUs[i] - tUs[i - 1]);
  return median(d);
}

/** Indices of strict local maxima of a series (plateaus report their first sample); null neighbours disqualify. */
export function localMaxima(series: Series): number[] {
  const out: number[] = [];
  const n = series.length;
  for (let i = 1; i < n - 1; i++) {
    const v = series[i];
    const prev = series[i - 1];
    if (v === null || prev === null || !(v > prev)) continue;
    let k = i + 1; // skip a plateau
    while (k < n && series[k] === v) k++;
    if (k < n && series[k] !== null && (series[k] as number) < v) out.push(i);
  }
  return out;
}

/**
 * Topographic prominence of the peak at i: its height above the higher of the two minima found walking left and
 * right until a sample higher than the peak (or the series end). Nulls are skipped.
 */
export function prominence(series: Series, i: number): number {
  const v = series[i] as number;
  const side = (step: -1 | 1): number => {
    let lo = v;
    for (let k = i + step; k >= 0 && k < series.length; k += step) {
      const s = series[k];
      if (s === null) continue;
      if (s > v) break;
      if (s < lo) lo = s;
    }
    return lo;
  };
  return v - Math.max(side(-1), side(1));
}

/** Three-point parabolic refinement around index i: fractional offset δ ∈ [−0.5, 0.5] and the refined value. */
export function parabolicPeak(series: Series, i: number): { delta: number; value: number } {
  const v0 = series[i] as number;
  const a = series[i - 1];
  const b = series[i + 1];
  if (a === null || b === null || a === undefined || b === undefined) return { delta: 0, value: v0 };
  const den = a - 2 * v0 + b;
  if (den >= 0) return { delta: 0, value: v0 };
  const delta = clamp((0.5 * (a - b)) / den, -0.5, 0.5);
  return { delta, value: v0 - 0.25 * (a - b) * delta };
}

/**
 * Leverage of the point t = 0 for a least-squares polynomial fit of the given order on `ts`, i.e. the variance of
 * the fitted value at 0 in units of the noise variance: (XᵀX)⁻¹₀₀. Infinity when singular.
 */
export function leverageAt0(ts: readonly number[], order: 1 | 2): number {
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
  for (const t of ts) {
    const t2 = t * t;
    s0 += 1;
    s1 += t;
    s2 += t2;
    s3 += t2 * t;
    s4 += t2 * t2;
  }
  if (order === 1) {
    const det = s0 * s2 - s1 * s1;
    return det > 0 ? s2 / det : Infinity;
  }
  const det = s0 * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2);
  return det > 0 ? (s2 * s4 - s3 * s3) / det : Infinity;
}
