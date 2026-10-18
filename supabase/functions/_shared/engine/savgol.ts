/**
 * Step 5 (DESIGN.md §6.2): zero-phase Savitzky–Golay smoothing, order 2, window 5 at 30 Hz / 9 at 60 Hz (≈ 133 ms).
 * The centred SG kernel is symmetric, so it introduces no phase lag. Velocities come from the SG first-derivative
 * kernel and are expressed in T/s. Where the window is incomplete (track edges, next to a null gap) the same local
 * quadratic is fitted to the available samples, so edges stay unbiased; a null centre stays null (never extrapolated).
 */
import { JOINT_ORDER } from '../contracts/common.ts';
import { mapJoints, polyFit } from './signal_util.ts';
import type { AnalysisHz, GridTrack, JointSeries, JointVelocity, Series, SmoothTrack } from './types.ts';

/** SG window length per analysis rate. */
export function sgWindowFor(hz: AnalysisHz): number {
  return hz === 60 ? 9 : 5;
}

/** Order-2 SG smoothing and first-derivative (per sample) kernels for half-width m. */
export function sgKernels(m: number): { smooth: number[]; deriv: number[] } {
  const smooth: number[] = [];
  const deriv: number[] = [];
  const den = (2 * m - 1) * (2 * m + 1) * (2 * m + 3);
  const dden = (m * (m + 1) * (2 * m + 1)) / 3;
  for (let k = -m; k <= m; k++) {
    smooth.push((3 * (3 * m * m + 3 * m - 1) - 15 * k * k) / den);
    deriv.push(k / dden);
  }
  return { smooth, deriv };
}

/** Smooths one series and returns values plus per-second derivatives (units of the series per second). */
export function sgFilter(series: Series, window: number, dtS: number): { value: Series; slope: Series } {
  const m = (window - 1) / 2;
  const { smooth, deriv } = sgKernels(m);
  const n = series.length;
  const value: Series = new Array(n).fill(null);
  const slope: Series = new Array(n).fill(null);
  const ts: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < n; i++) {
    if (series[i] === null) continue;
    let full = i - m >= 0 && i + m < n;
    if (full) {
      for (let k = -m; k <= m; k++) {
        if (series[i + k] === null) {
          full = false;
          break;
        }
      }
    }
    if (full) {
      let v = 0, d = 0;
      for (let k = -m; k <= m; k++) {
        const y = series[i + k] as number;
        v += smooth[k + m] * y;
        d += deriv[k + m] * y;
      }
      value[i] = v;
      slope[i] = d / dtS;
      continue;
    }
    ts.length = 0;
    ys.length = 0;
    for (let k = -m; k <= m; k++) {
      const y = i + k >= 0 && i + k < n ? series[i + k] : null;
      if (y === null) continue;
      ts.push(k * dtS);
      ys.push(y);
    }
    const fit = polyFit(ts, ys, ts.length >= 3 ? 2 : ts.length === 2 ? 1 : 0);
    value[i] = fit ? fit[0] : series[i];
    slope[i] = fit && ts.length >= 2 ? fit[1] : null;
  }
  return { value, slope };
}

/** Applies SG smoothing to every joint and adds SG-derivative velocities in T/s. */
export function smoothTrack(track: GridTrack): SmoothTrack {
  const window = sgWindowFor(track.hz);
  const vel = {} as Record<(typeof JOINT_ORDER)[number], JointVelocity>;
  const joints = mapJoints((j): JointSeries => {
    const s = track.joints[j];
    const fx = sgFilter(s.x, window, track.dtS);
    const fy = sgFilter(s.y, window, track.dtS);
    const n = s.x.length;
    const vx: Series = new Array(n).fill(null);
    const vy: Series = new Array(n).fill(null);
    const speed: Series = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      const dx = fx.slope[i], dy = fy.slope[i];
      if (dx === null || dy === null) continue;
      vx[i] = dx / track.torsoT;
      vy[i] = dy / track.torsoT;
      speed[i] = Math.hypot(vx[i] as number, vy[i] as number);
    }
    vel[j] = { vx, vy, speed };
    return { x: fx.value, y: fy.value, c: s.c.slice() };
  });
  return { ...track, joints, vel, sgWindow: window };
}
