/**
 * Step 3 (DESIGN.md §6.2): Hampel filter on residuals of a local quadratic fit.
 *
 * A plain Hampel filter on positions (median of a window) clips real fast turnarounds, because a 20–30 T/s wrist
 * reversal looks like an outlier against the window median. Here each sample is compared with a quadratic fitted in
 * time (actual `tUs`, so VFR jitter and gaps are respected) to its neighbours within ±100 ms, excluding the sample
 * itself (leave-one-out, so a spike cannot pull the fit toward itself). The sample is set missing when its residual
 * exceeds 3 robust σ, where σ = 1.4826·MAD of the neighbours' residuals (about zero, since LS residuals are
 * centred) inflated to the leave-one-out prediction error, with a floor in T so that quantization-level residuals of a
 * near-perfect fit never trigger. The window half-width is extended to 200 ms on a side that has no sample within
 * 100 ms (a spike next to a dropped-frame gap is still judged from both sides).
 * Known limit: a spike sitting inside an extreme reversal (≈ 25 T/s V-turn within ±50 ms) can be masked, because the
 * reversal itself inflates the neighbours' residuals.
 */
import { JOINT_ORDER } from '../contracts/common.ts';
import { cloneRawTrack, leverageAt0, median, polyFit } from './signal_util.ts';
import type { RawTrack, Series } from './types.ts';

/** Tunables (defaults per DESIGN.md §6.2 step 3). */
export interface HampelOptions {
  /** Half window in µs (default 100 ms). */
  halfWindowUs: number;
  /** Threshold in robust σ (default 3). */
  nSigma: number;
  /** σ floor as a fraction of T (default 0.05 T ≈ 2.5 cm, about Vision's joint jitter at 60 % player height). */
  sigmaFloorT: number;
  /** Minimum neighbours (excluding the sample) needed to judge a sample (default 4, at least 1 per side). */
  minNeighbours: number;
}

/** Default Hampel parameters. */
export const HAMPEL_DEFAULTS: HampelOptions = {
  halfWindowUs: 100_000,
  nSigma: 3,
  sigmaFloorT: 0.05,
  minNeighbours: 4,
};

/** Result of the Hampel stage. */
export interface HampelResult {
  track: RawTrack;
  /** Number of joint samples set missing. */
  removed: number;
}

/** Flags outlier samples per coordinate of one series; returns the indices to drop. */
export function hampelOutliers(
  tUs: readonly number[],
  series: Series,
  sigmaFloor: number,
  opts: HampelOptions,
): number[] {
  const n = tUs.length;
  const out: number[] = [];
  const ts: number[] = [];
  const ys: number[] = [];
  const h = opts.halfWindowUs;
  // Neighbours on one side: every present sample within h; if none, the nearest present one within 2h, so a
  // spike right next to a dropped-frame gap can still be judged against both sides.
  const collect = (i: number, step: -1 | 1): number => {
    let count = 0;
    for (let k = i + step; k >= 0 && k < n; k += step) {
      const dt = Math.abs(tUs[k] - tUs[i]);
      if (dt > 2 * h || (dt > h && count > 0)) break;
      const yk = series[k];
      if (yk === null) continue;
      ts.push((tUs[k] - tUs[i]) / 1e6);
      ys.push(yk);
      count++;
      if (dt > h) break;
    }
    return count;
  };
  for (let i = 0; i < n; i++) {
    const yi = series[i];
    if (yi === null) continue;
    ts.length = 0;
    ys.length = 0;
    const left = collect(i, -1);
    const right = collect(i, 1);
    if (ts.length < opts.minNeighbours || left === 0 || right === 0) continue;
    // A quadratic needs ≥ 5 neighbours to leave a usable residual spread; with fewer, fit a line.
    const order = ts.length >= 5 ? 2 : 1;
    const fit = polyFit(ts, ys, order);
    if (!fit) continue;
    const r = yi - fit[0];
    // σ is never below the floor, so a residual within nSigma·floor can never be an outlier: skip the MAD (the
    // sort it needs dominated the prepare budget; the result is identical).
    if (Math.abs(r) <= opts.nSigma * sigmaFloor) continue;
    // Robust σ of the neighbours' residuals, inflated to the leave-one-out prediction error at the sample:
    // residuals of a p-parameter fit are deflated by (n−p)/n, and the fitted value itself has variance h0·σ².
    const resid = ys.map((y, k) => y - evalPoly(fit, ts[k]));
    const p = order + 1;
    const inflate = Math.sqrt(ts.length / (ts.length - p)) * Math.sqrt(1 + leverageAt0(ts, order));
    const sigma = Math.max(1.4826 * median(resid.map(Math.abs)) * inflate, sigmaFloor);
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
