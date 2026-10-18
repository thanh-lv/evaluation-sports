/**
 * Step 1 (DESIGN.md §6.2, DESIGN-v1.0 §6.2 step 1): dequantize pose.v1 CFS integers, aspect-correct to frame-height
 * units with y up, gate confidence (c < 0.3 → missing, D8) and compute the torso unit T.
 */
import { CFS_MAX, CONF_MAX, JOINT_ORDER, KP_STRIDE } from '../contracts/common.ts';
import type { PoseV1 } from '../contracts/pose_v1.ts';
import { median, mapJoints } from './signal_util.ts';
import { type BoxCfs, EngineRejection, type JointMap, type JointSeries, type RawTrack } from './types.ts';

/** Joints with confidence below this are treated as missing (DESIGN.md D8). */
export const MIN_JOINT_CONF = 0.3;

/** Converts pose.v1 into a RawTrack; throws EngineRejection('low_visibility') when T cannot be measured. */
export function normalizePose(pose: Pick<PoseV1, 'track' | 'video'>): RawTrack {
  const { track, video } = pose;
  const aspect = video.display.w / video.display.h;
  const n = track.tUs.length;
  const joints: JointMap<JointSeries> = mapJoints(() => ({
    x: new Array<number | null>(n).fill(null),
    y: new Array<number | null>(n).fill(null),
    c: new Array<number>(n).fill(0),
  }));
  for (let i = 0; i < n; i++) {
    const row = track.kp[i];
    JOINT_ORDER.forEach((j, ji) => {
      const k = ji * KP_STRIDE;
      const c = row[k + 2] / CONF_MAX;
      if (c < MIN_JOINT_CONF) return; // includes the 0,0,0 sentinel
      const s = joints[j];
      s.x[i] = (row[k] / CFS_MAX) * aspect;
      s.y[i] = 1 - row[k + 1] / CFS_MAX;
      s.c[i] = c;
    });
  }
  const torsoT = torsoUnit(joints, n);
  if (!(torsoT > 0)) throw new EngineRejection('low_visibility', 'torso unit T could not be measured');
  return {
    tUs: track.tUs.slice(),
    joints,
    flags: track.flags.slice(),
    bboxCfs: track.bbox.map((b) => [b[0], b[1], b[2], b[3]] as BoxCfs),
    aspect,
    display: { w: video.display.w, h: video.display.h },
    torsoT,
    mirrored: video.mirrored,
    mirrorSwapApplied: false,
  };
}

/**
 * T = median over samples of |neck − root|; a sample missing neck or root falls back to
 * |shoulder midpoint − hip midpoint|. Returns NaN when no sample has either.
 */
export function torsoUnit(joints: JointMap<JointSeries>, n: number): number {
  const d: number[] = [];
  const pt = (s: JointSeries, i: number): [number, number] | null =>
    s.x[i] !== null && s.y[i] !== null ? [s.x[i] as number, s.y[i] as number] : null;
  const mid = (a: [number, number] | null, b: [number, number] | null): [number, number] | null =>
    a && b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : null;
  for (let i = 0; i < n; i++) {
    let top = pt(joints.neck, i);
    let bottom = pt(joints.root, i);
    if (!top || !bottom) {
      top = mid(pt(joints.lSho, i), pt(joints.rSho, i));
      bottom = mid(pt(joints.lHip, i), pt(joints.rHip, i));
    }
    if (top && bottom) d.push(Math.hypot(top[0] - bottom[0], top[1] - bottom[1]));
  }
  return median(d);
}
