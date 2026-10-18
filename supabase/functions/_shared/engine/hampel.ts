/**
 * Step 3 (DESIGN.md §6.2): Hampel filter on residuals of a local quadratic fit.
 *
 * A plain Hampel filter on positions (median of a window) clips real fast turnarounds, because a 20–30 T/s wrist
 * reversal looks like an outlier against the window median. Here each sample is compared with a quadratic fitted in
 * time (actual `tUs`, so VFR jitter and gaps are respected) to its neighbours within ±100 ms, excluding the sample
 * itself (leave-one-out, so a spike cannot pull the fit toward itself). The sample is set missing when its residual
 * exceeds 3 robust σ of the neighbours' residuals (σ = 1.4826·MAD), with a floor in T so that quantization-level
 * residuals of a near-perfect fit never trigger.
 */
import { JOINT_ORDER } from '../contracts/common.ts';
import { cloneRawTrack, median, polyFit } from './signal_util.ts';
import type { RawTrack, Series } from './types.ts';

/** Tunables (defaults per DESIGN.md §6.2 step 3). */
export interface HampelOptions {
  /** Half window in µs (default 100 ms). */
  halfWindowUs: number;
  /** Threshold in robust σ (default 3). */
  nSigma: number;
  /** σ floor as a fraction of T (default 0.04 T ≈ 2 cm). */
  sigmaFloorT: number;
  /** Minimum neighbours (excluding the sample) needed to judge a sample (default 4, at least 1 per side). */
  minNeighbours: number;
}

/** Default Hampel parameters. */
export const HAMPEL_DEFAULTS: HampelOptions = {
  halfWindowUs: 100_000,
  nSigma: 3,
  sigmaFloorT: 0.04,
  minNeighbours: 4,
};

/** Result of the Hampel stage. */
export interface HampelResult {
  track: RawTrack;
  /** Number of joint samples set missing. */
  removed: number;
}

/** Flags outlier samples per coordinate of one series; returns the indices to drop. */
export function hampelOutliers(tUs: readonly number[], series: Series, sigmaFloor: number, opts: HampelOptions): number[] {
  const n = tUs.length;
  const out: number[] = [];
  const ts: number[] = [];
  const ys: number[] = [];
  let lo = 0;
  for (let i = 0; i < n; i++) {
    const yi = series[i];
    if (yi === null) continue;
    const ti = tUs[i];
    while (tUs[lo] < ti - opts.halfWindowUs) lo++;
    ts.length = 0;
    ys.length = 0;
    let left = 0, right = 0;
    for (let k = lo; k < n && tUs[k] <= ti + opts.halfWindowUs; k++) {
      const yk = series[k];
      if (k === i || yk === null) continue;
      ts.push((tUs[k] - ti) / 1e6);
      ys.push(yk);
      if (k < i) left++;
      else right++;
    }
    if (ts.length < opts.minNeighbours || left === 0 || right === 0) continue;
    // Quadratic needs ≥ 4 points for a residual spread; with 3 neighbours fall back to linear.
    const order = ts.length >= 5 ? 2 : 1;
    const fit = polyFit(ts, ys, order);
    if (!fit) continue;
    const resid = ys.map((y, k) => y - evalPoly(fit, ts[k]));
    const sigma = Math.max(1.4826 * median(resid.map(Math.abs)), sigmaFloor);
    const r = yi - fit[0];
    if (Math.abs(r) > opts.nSigma * sigma) out.push(i);
  }
  return out;
}

/** Sets Hampel outliers missing in every joint (x and y judged separately; either one drops the joint sample). */
export function hampelFilter(track: RawTrack, options: Partial<HampelOptions> = {}): HampelResult {
  const opts = { ...HAMPEL_DEFAULTS, ...options };
  const out = cloneRawTrack(track);
  const floor = opts.sigmaFloorT * track.torsoT;
  let removed = 0;
  for (const j of JOINT_ORDER) {
    const s = out.joints[j];
    const drop = new Set([
      ...hampelOutliers(track.tUs, track.joints[j].x, floor, opts),
      ...hampelOutliers(track.tUs, track.joints[j].y, floor, opts),
    ]);
    for (const i of drop) {
      s.x[i] = null;
      s.y[i] = null;
      s.c[i] = 0;
      removed++;
    }
  }
  return { track: out, removed };
}

function evalPoly(c: readonly number[], t: number): number {
  return c[0] + c[1] * t + c[2] * t * t;
}
