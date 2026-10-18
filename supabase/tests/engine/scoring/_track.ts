/**
 * Hand-built tracks for golden metric tests. Joints are given analytically in frame-height units (y up) on an exact
 * uniform grid, so resampling is a copy and SG smoothing is exact for constant / linear / quadratic motion: metric
 * values can be checked against closed-form numbers without quantization noise.
 */
import { type Joint, JOINT_ORDER } from '@shared/contracts/index.ts';
import { resampleTrack, uniformGrid } from '@shared/engine/resample.ts';
import { smoothTrack } from '@shared/engine/savgol.ts';
import { gridIndexAt, mapJoints } from '@shared/engine/signal_util.ts';
import type { AnalysisHz, BoxCfs, PhasePoint, RawTrack, SmoothTrack, StrokePhases } from '@shared/engine/types.ts';

export type XY = [number, number];
export type Frame = Partial<Record<Joint, XY>>;

export const T0_US = 1_000_000;
export const ASPECT = 16 / 9;

/** Builds a SmoothTrack from `frame(tS)` (tS = seconds since t0) over `durationS`. */
export function trackFrom(
  frame: (tS: number) => Frame,
  opts: { hz?: AnalysisHz; durationS?: number; torsoT?: number; conf?: number; mirrored?: boolean } = {},
): SmoothTrack {
  const hz = opts.hz ?? 60;
  const tUs = uniformGrid(T0_US, T0_US + Math.round((opts.durationS ?? 4) * 1e6), hz);
  const n = tUs.length;
  const conf = opts.conf ?? 0.9;
  const joints = mapJoints(() => ({
    x: new Array<number | null>(n).fill(null),
    y: new Array<number | null>(n).fill(null),
    c: new Array<number>(n).fill(0),
  }));
  const bboxCfs: BoxCfs[] = [];
  for (let i = 0; i < n; i++) {
    const f = frame((tUs[i] - T0_US) / 1e6);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const j of JOINT_ORDER) {
      const p = f[j];
      if (!p) continue;
      joints[j].x[i] = p[0];
      joints[j].y[i] = p[1];
      joints[j].c[i] = conf;
      const cx = (p[0] / ASPECT) * 1000, cy = (1 - p[1]) * 1000;
      x0 = Math.min(x0, cx);
      x1 = Math.max(x1, cx);
      y0 = Math.min(y0, cy);
      y1 = Math.max(y1, cy);
    }
    bboxCfs.push(Number.isFinite(x0) ? [x0, y0, x1 - x0, y1 - y0] : [0, 0, 0, 0]);
  }
  const raw: RawTrack = {
    tUs,
    joints,
    flags: new Array<number>(n).fill(0),
    bboxCfs,
    aspect: ASPECT,
    display: { w: 1920, h: 1080 },
    torsoT: opts.torsoT ?? 0.2,
    mirrored: opts.mirrored ?? false,
    mirrorSwapApplied: opts.mirrored ?? false,
  };
  return smoothTrack(resampleTrack(raw, hz));
}

/** A phase point on the grid (snapped = grid time, which is a sample of the hand-built raw track). */
export function at(track: SmoothTrack, tS: number): PhasePoint {
  const index = gridIndexAt(track, T0_US + tS * 1e6);
  return { tUs: track.tUs[index], index, snappedUs: track.tUs[index] };
}

/** Stroke phases from times in seconds; `readyWindow` defaults to [ready − 0.25, ready + 0.25]. */
export function phasesAt(
  track: SmoothTrack,
  t: {
    ready: number;
    bsEnd: number;
    contact: number;
    ftStop: number;
    recovery?: number | null;
    swingStart?: number | null;
    readyWindow?: [number, number] | null;
  },
  strokeId = 1,
): StrokePhases {
  const ready = at(track, t.ready);
  const w = t.readyWindow === undefined ? [t.ready - 0.25, t.ready + 0.25] : t.readyWindow;
  const readyWindow = w
    ? (() => {
      const a = at(track, w[0]), b = at(track, w[1]);
      return { startIndex: a.index, endIndex: b.index, startUs: a.tUs, endUs: b.tUs };
    })()
    : null;
  const recovery = t.recovery === null ? null : at(track, t.recovery ?? t.contact + 1);
  const swingStart = t.swingStart === null || t.swingStart === undefined ? null : at(track, t.swingStart);
  const contact = at(track, t.contact);
  const ftStop = at(track, t.ftStop);
  return {
    strokeId,
    swingStart,
    ready,
    readyWindow,
    readyAssessable: readyWindow !== null,
    bsEnd: at(track, t.bsEnd),
    contact,
    ftStop,
    recovery,
    tStartUs: readyWindow ? readyWindow.startUs : ready.tUs,
    tEndUs: recovery ? recovery.tUs : ftStop.tUs,
  };
}

const rad = Math.PI / 180;

/** Point at distance `len` from `from` in direction `deg` measured from straight up (+ = toward +x). */
export function polar(from: XY, len: number, deg: number): XY {
  return [from[0] + len * Math.sin(deg * rad), from[1] + len * Math.cos(deg * rad)];
}

/**
 * Upright right-handed stick figure facing +x with T = 0.2: root (1, 0.5), neck (1, 0.7), shoulders 0.2 apart in x
 * (SW = 1 T), straight legs, arms hanging. Override any joint.
 */
export function standing(over: Frame = {}): Frame {
  const root: XY = [1, 0.5];
  const neck: XY = [1, 0.7];
  const base: Frame = {
    nose: [1.04, 0.76],
    lEye: [1.03, 0.77],
    rEye: [1.03, 0.77],
    neck,
    root,
    lSho: [0.9, 0.68],
    rSho: [1.1, 0.68],
    lElb: [0.9, 0.53],
    rElb: [1.1, 0.53],
    lWri: [0.9, 0.38],
    rWri: [1.1, 0.38],
    lHip: [0.96, 0.5],
    rHip: [1.04, 0.5],
    lKne: [0.96, 0.3],
    rKne: [1.04, 0.3],
    lAnk: [0.96, 0.1],
    rAnk: [1.04, 0.1],
  };
  return { ...base, ...over };
}
