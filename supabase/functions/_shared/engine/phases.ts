/**
 * Step 8 (DESIGN.md §6.2; definitions from DESIGN-v1.0 §6.2 step 5), per stroke, with tc = estimated contact and v the
 * racket-wrist speed:
 * - ready   = median pose over [tc−1.2 s, tc−0.7 s], starting no earlier than the previous stroke's ftStop + 0.3 s;
 *             < 0.2 s left → not assessed. The ready *frame* is the sample closest to that median pose.
 * - bsEnd   = argmin v in [tc−0.6 s, tc−0.05 s] (backswing turnaround).
 * - contact = tc.
 * - ftStop  = first t ∈ (tc, tc+0.8 s] with v < max(0.5, 0.2·vPeak), else tc+0.8 s.
 * - recovery = tc+1.0 s (null past the track end).
 * - swingStart = last t < bsEnd with v < 0.5 T/s, within 1 s (null if none).
 * Every phase also carries `snappedUs`: the nearest sampled original PTS that is not coasted and has the racket
 * wrist observed after cleanup, so frame requests always name a real decoded frame.
 */
import { type Handedness, type Joint, JOINT_ORDER } from '../contracts/common.ts';
import { FLAG_COASTED } from '../contracts/pose_v1.ts';
import { racketWrist } from './handedness.ts';
import { clamp, gridIndexAt, gridRange, isPresent, median, nearestIndex } from './signal_util.ts';
import type { DetectedStroke, GridWindow, PhasePoint, RawTrack, SmoothTrack, StrokePhases } from './types.ts';

/** Phase timing constants (seconds / T/s) from DESIGN-v1.0 §6.2 step 5. */
export const PHASE_CONSTANTS = {
  readyFromS: -1.2,
  readyToS: -0.7,
  readyAfterPrevFtStopS: 0.3,
  readyMinS: 0.2,
  bsFromS: -0.6,
  bsToS: -0.05,
  ftMaxS: 0.8,
  ftStopAbs: 0.5,
  ftStopFrac: 0.2,
  recoveryS: 1.0,
  swingStartV: 0.5,
  swingStartMaxS: 1.0,
} as const;

/**
 * Nearest original sampled PTS to `tUs` whose frame is not coasted and has every `joints` entry observed in the
 * cleaned raw track; falls back to the nearest original PTS when no sample qualifies.
 */
export function snapToSampled(raw: RawTrack, tUs: number, joints: readonly Joint[] = []): number {
  const n = raw.tUs.length;
  const start = nearestIndex(raw.tUs, tUs);
  const good = (k: number): boolean => {
    if (raw.flags[k] & FLAG_COASTED) return false;
    if (joints.length > 0) return joints.every((j) => isPresent(raw.joints[j], k));
    return JOINT_ORDER.some((j) => isPresent(raw.joints[j], k));
  };
  let best = -1;
  for (let lo = start, hi = start + 1; lo >= 0 || hi < n;) {
    const dLo = lo >= 0 ? Math.abs(tUs - raw.tUs[lo]) : Infinity;
    const dHi = hi < n ? Math.abs(raw.tUs[hi] - tUs) : Infinity;
    const k = dLo <= dHi ? lo-- : hi++;
    if (good(k)) {
      best = k;
      break;
    }
  }
  return raw.tUs[best >= 0 ? best : start];
}

/** Computes the engine phases for every stroke (strokes in time order; each one's ready window sees the previous). */
export function computePhases(
  track: SmoothTrack,
  strokes: readonly DetectedStroke[],
  handedness: Handedness,
): StrokePhases[] {
  const P = PHASE_CONSTANTS;
  const wrist = racketWrist(handedness);
  const v = track.vel[wrist].speed;
  const t0 = track.tUs[0];
  const tEnd = track.tUs[track.tUs.length - 1];
  const s2us = (s: number) => s * 1e6;
  const point = (tUs: number): PhasePoint => ({
    tUs,
    index: gridIndexAt(track, tUs),
    snappedUs: snapToSampled(track.raw, tUs, [wrist]),
  });
  const gridPoint = (i: number): PhasePoint => point(track.tUs[i]);

  const out: StrokePhases[] = [];
  let prevFtStopUs = -Infinity;
  for (const s of strokes) {
    const tc = s.tContactUs;
    const contact = point(tc);

    // bsEnd: argmin v over [tc−0.6, tc−0.05].
    const bsRange = gridRange(track, tc + s2us(P.bsFromS), tc + s2us(P.bsToS));
    const bsIdx = bsRange ? argminPresent(v, bsRange[0], bsRange[1]) : -1;
    const bsEnd = bsIdx >= 0 ? gridPoint(bsIdx) : point(clamp(tc + s2us(P.bsFromS / 2), t0, tc));

    // ftStop: first sample after tc below max(0.5, 0.2·vPeak).
    const stopV = Math.max(P.ftStopAbs, P.ftStopFrac * s.vPeak);
    const ftLimit = Math.min(tc + s2us(P.ftMaxS), tEnd);
    let ftStop = point(ftLimit);
    const ftRange = gridRange(track, tc + 1, ftLimit);
    if (ftRange) {
      for (let i = ftRange[0]; i <= ftRange[1]; i++) {
        const vi = v[i];
        if (vi !== null && vi < stopV) {
          ftStop = gridPoint(i);
          break;
        }
      }
    }

    const recUs = tc + s2us(P.recoveryS);
    const recovery = recUs <= tEnd ? point(recUs) : null;

    // swingStart: last sample before bsEnd with v < 0.5, within 1 s.
    let swingStart: PhasePoint | null = null;
    const ssRange = gridRange(track, bsEnd.tUs - s2us(P.swingStartMaxS), bsEnd.tUs - 1);
    if (ssRange) {
      for (let i = ssRange[1]; i >= ssRange[0]; i--) {
        const vi = v[i];
        if (vi !== null && vi < P.swingStartV) {
          swingStart = gridPoint(i);
          break;
        }
      }
    }

    // ready: median-pose window, clipped after the previous stroke's ftStop + 0.3 s.
    const rStart = Math.max(tc + s2us(P.readyFromS), prevFtStopUs + s2us(P.readyAfterPrevFtStopS), t0);
    const rEnd = tc + s2us(P.readyToS);
    const rRange = rEnd - rStart >= s2us(P.readyMinS) ? gridRange(track, rStart, rEnd) : null;
    let readyWindow: GridWindow | null = null;
    let ready: PhasePoint;
    if (rRange) {
      readyWindow = {
        startIndex: rRange[0],
        endIndex: rRange[1],
        startUs: track.tUs[rRange[0]],
        endUs: track.tUs[rRange[1]],
      };
      ready = gridPoint(medoidIndex(track, rRange[0], rRange[1]));
    } else {
      const lo = Math.min(Math.max(prevFtStopUs + s2us(P.readyAfterPrevFtStopS), t0), bsEnd.tUs);
      ready = point(clamp(tc + s2us(P.readyToS), lo, bsEnd.tUs));
    }

    // Span: earliest of the ready window, swingStart and the phase frames … recovery (or ftStop).
    const starts = [ready.snappedUs, bsEnd.snappedUs, contact.snappedUs];
    if (swingStart) starts.push(swingStart.snappedUs);
    if (readyWindow) starts.push(snapToSampled(track.raw, readyWindow.startUs, [wrist]));
    const tEndUs = Math.max(recovery?.snappedUs ?? ftStop.snappedUs, ftStop.snappedUs, contact.snappedUs);
    out.push({
      strokeId: s.id,
      swingStart,
      ready,
      readyWindow,
      readyAssessable: readyWindow !== null,
      bsEnd,
      contact,
      ftStop,
      recovery,
      tStartUs: Math.min(...starts),
      tEndUs,
    });
    prevFtStopUs = ftStop.tUs;
  }
  return out;
}

/** Index of the smallest non-null value in [a, b], or -1. */
function argminPresent(v: readonly (number | null)[], a: number, b: number): number {
  let best = -1;
  for (let i = a; i <= b; i++) {
    const x = v[i];
    if (x !== null && (best < 0 || x < (v[best] as number))) best = i;
  }
  return best;
}

/** Grid sample in [a, b] whose pose is closest (mean joint distance) to the per-joint median pose of the window. */
export function medoidIndex(track: SmoothTrack, a: number, b: number): number {
  const med = JOINT_ORDER.map((j) => {
    const s = track.joints[j];
    const xs: number[] = [], ys: number[] = [];
    for (let i = a; i <= b; i++) {
      if (s.x[i] !== null && s.y[i] !== null) {
        xs.push(s.x[i] as number);
        ys.push(s.y[i] as number);
      }
    }
    return xs.length ? [median(xs), median(ys)] : null;
  });
  let best = a, bestD = Infinity;
  for (let i = a; i <= b; i++) {
    let d = 0, k = 0;
    JOINT_ORDER.forEach((j, ji) => {
      const m = med[ji];
      const s = track.joints[j];
      if (!m || s.x[i] === null || s.y[i] === null) return;
      d += Math.hypot((s.x[i] as number) - m[0], (s.y[i] as number) - m[1]);
      k++;
    });
    if (k > 0 && d / k < bestD) {
      bestD = d / k;
      best = i;
    }
  }
  return best;
}
