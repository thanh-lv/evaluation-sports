/**
 * Step 4 (DESIGN.md §6.2): resample the cleaned raw track onto a uniform grid at `analysisHz` and fill gaps.
 *
 * Per joint and grid time t, the bracketing observed samples a ≤ t ≤ b are found on the raw timeline:
 * - consecutive observations (no missing sample and no dropped frame between a and b): linear interpolation;
 * - a gap (missing samples or a PTS jump > 1.5× the median frame interval) of span ≤ 100 ms: linear, interp bit set;
 * - span ≤ 200 ms with good ends (an observed neighbour beyond each end for the tangent): cubic Hermite, interp set;
 * - anything longer, or outside the observed range: null.
 * Gap-filled confidences are scaled down (×0.7 linear, ×0.5 Hermite) so downstream confidences reflect the fill.
 */
import { mapJoints, medianIntervalUs } from './signal_util.ts';
import type { AnalysisHz, GridTrack, JointSeries, RawTrack } from './types.ts';

/** Gap-fill limits (DESIGN.md D6). */
export const LINEAR_GAP_MAX_US = 100_000;
export const HERMITE_GAP_MAX_US = 200_000;
/** Confidence multipliers for gap-filled samples. */
export const LINEAR_FILL_CONF = 0.7;
export const HERMITE_FILL_CONF = 0.5;

/** Uniform grid times `t0 + round(i·1e6/hz)` covering [t0, tEnd]. */
export function uniformGrid(t0Us: number, tEndUs: number, hz: AnalysisHz): number[] {
  const out: number[] = [];
  for (let i = 0;; i++) {
    const t = t0Us + Math.round((i * 1e6) / hz);
    if (t > tEndUs) break;
    out.push(t);
  }
  return out;
}

/** Resamples every joint of `raw` onto the uniform grid with gap fill and an interp mask. */
export function resampleTrack(raw: RawTrack, hz: AnalysisHz): GridTrack {
  const t0Us = raw.tUs[0];
  const grid = uniformGrid(t0Us, raw.tUs[raw.tUs.length - 1], hz);
  const m = grid.length;
  const interp = new Array<number>(m).fill(0);
  // A PTS jump longer than this between two observed samples is a dropped-frame gap.
  const nominal = medianIntervalUs(raw.tUs);
  const jumpUs = 1.5 * (Number.isFinite(nominal) ? nominal : 1e6 / hz);

  const joints = mapJoints((j, ji) => {
    const r = raw.joints[j];
    const obs: number[] = [];
    for (let k = 0; k < raw.tUs.length; k++) if (r.x[k] !== null && r.y[k] !== null) obs.push(k);
    const out: JointSeries = {
      x: new Array<number | null>(m).fill(null),
      y: new Array<number | null>(m).fill(null),
      c: new Array<number>(m).fill(0),
    };
    let p = 0; // position in obs: obs[p] is the last observation with time ≤ t
    for (let i = 0; i < m; i++) {
      const t = grid[i];
      while (p + 1 < obs.length && raw.tUs[obs[p + 1]] <= t) p++;
      if (obs.length === 0 || raw.tUs[obs[p]] > t) continue;
      const a = obs[p];
      const ta = raw.tUs[a];
      if (ta === t) {
        out.x[i] = r.x[a];
        out.y[i] = r.y[a];
        out.c[i] = r.c[a];
        continue;
      }
      if (p + 1 >= obs.length) continue; // past the last observation
      const b = obs[p + 1];
      const tb = raw.tUs[b];
      const span = tb - ta;
      const isGap = b > a + 1 || span > jumpUs;
      const u = (t - ta) / span;
      const xa = r.x[a] as number, ya = r.y[a] as number, xb = r.x[b] as number, yb = r.y[b] as number;
      if (!isGap || span <= LINEAR_GAP_MAX_US) {
        out.x[i] = xa + (xb - xa) * u;
        out.y[i] = ya + (yb - ya) * u;
        out.c[i] = isGap ? Math.min(r.c[a], r.c[b]) * LINEAR_FILL_CONF : r.c[a] + (r.c[b] - r.c[a]) * u;
        if (isGap) interp[i] |= 1 << ji;
        continue;
      }
      if (span > HERMITE_GAP_MAX_US) continue;
      // Hermite needs a good end on both sides: the neighbouring observation must be the adjacent raw sample.
      const a0 = p > 0 ? obs[p - 1] : -1;
      const b1 = p + 2 < obs.length ? obs[p + 2] : -1;
      if (a0 !== a - 1 || b1 !== b + 1) continue;
      const dA = (raw.tUs[a] - raw.tUs[a0]) / 1e6;
      const dB = (raw.tUs[b1] - raw.tUs[b]) / 1e6;
      const h = span / 1e6;
      const mxa = ((r.x[a] as number) - (r.x[a0] as number)) / dA;
      const mya = ((r.y[a] as number) - (r.y[a0] as number)) / dA;
      const mxb = ((r.x[b1] as number) - (r.x[b] as number)) / dB;
      const myb = ((r.y[b1] as number) - (r.y[b] as number)) / dB;
      out.x[i] = hermite(xa, xb, mxa * h, mxb * h, u);
      out.y[i] = hermite(ya, yb, mya * h, myb * h, u);
      out.c[i] = Math.min(r.c[a], r.c[b]) * HERMITE_FILL_CONF;
      interp[i] |= 1 << ji;
    }
    return out;
  });

  const flags = new Array<number>(m).fill(0);
  for (let k = 0; k < raw.tUs.length; k++) {
    if (!raw.flags[k]) continue;
    const g = Math.round(((raw.tUs[k] - t0Us) * hz) / 1e6);
    if (g >= 0 && g < m) flags[g] |= raw.flags[k];
  }
  return {
    hz,
    t0Us,
    tUs: grid,
    dtS: 1 / hz,
    joints,
    interp,
    flags,
    torsoT: raw.torsoT,
    aspect: raw.aspect,
    raw,
  };
}

/** Cubic Hermite on u ∈ [0,1] with end values p0, p1 and tangents m0, m1 already scaled by the span. */
export function hermite(p0: number, p1: number, m0: number, m1: number, u: number): number {
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * m1;
}
