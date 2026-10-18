/**
 * Step 9 (DESIGN.md §6.2; DESIGN-v1.0 §6.2 step 6): sign conventions for directional metrics.
 * - `f` (hitting direction, side view): sign of the mean horizontal racket-wrist velocity over [tc−0.1, tc+0.1],
 *   majority vote across strokes. A weak vote falls back to nose vs ear midpoint in the ready windows.
 * - `h` (lateral sign): behind view image-right = player-right; front view is mirrored; left-handers flip.
 */
import type { ConfirmedCameraView, Handedness } from '../contracts/common.ts';
import { racketWrist } from './handedness.ts';
import { gridRange, median } from './signal_util.ts';
import type { DirectionResult, DetectedStroke, GridWindow, SmoothTrack } from './types.ts';

/** Direction-vote constants. */
export const DIRECTION_CONSTANTS = {
  windowUs: 100_000,
  /** |mean vx| below this (T/s) abstains. */
  minVoteSpeed: 0.5,
  /** The winning side needs at least this share of the non-abstaining votes. */
  minShare: 2 / 3,
  /** |nose.x − earMid.x| below this (in T) is too ambiguous for the face fallback. */
  minFaceOffsetT: 0.05,
} as const;

/** Decides the hitting-direction sign f from the strokes, with the face fallback. */
export function hittingDirection(
  track: SmoothTrack,
  strokes: readonly Pick<DetectedStroke, 'tContactUs'>[],
  handedness: Handedness,
  readyWindows: readonly (GridWindow | null)[] = [],
): DirectionResult {
  const C = DIRECTION_CONSTANTS;
  const vx = track.vel[racketWrist(handedness)].vx;
  const votes = { pos: 0, neg: 0, abstain: 0 };
  for (const s of strokes) {
    const range = gridRange(track, s.tContactUs - C.windowUs, s.tContactUs + C.windowUs);
    let sum = 0, k = 0;
    if (range) {
      for (let i = range[0]; i <= range[1]; i++) {
        const x = vx[i];
        if (x !== null) {
          sum += x;
          k++;
        }
      }
    }
    const mean = k ? sum / k : 0;
    if (Math.abs(mean) < C.minVoteSpeed) votes.abstain++;
    else if (mean > 0) votes.pos++;
    else votes.neg++;
  }
  const voting = votes.pos + votes.neg;
  if (voting > 0 && Math.max(votes.pos, votes.neg) / voting >= C.minShare && votes.pos !== votes.neg) {
    return { f: votes.pos > votes.neg ? 1 : -1, source: 'wrist', votes };
  }
  const face = faceDirection(track, readyWindows);
  if (face !== null) return { f: face, source: 'face', votes };
  return { f: 1, source: 'default', votes };
}

/** Sign of median(nose.x − ear midpoint.x) over the ready windows (one ear suffices); null when ambiguous. */
export function faceDirection(track: SmoothTrack, windows: readonly (GridWindow | null)[]): 1 | -1 | null {
  const { nose, lEar, rEar } = track.joints;
  const d: number[] = [];
  for (const w of windows) {
    if (!w) continue;
    for (let i = w.startIndex; i <= w.endIndex; i++) {
      const nx = nose.x[i];
      if (nx === null) continue;
      const ears = [lEar.x[i], rEar.x[i]].filter((e): e is number => e !== null);
      if (ears.length === 0) continue;
      d.push(nx - ears.reduce((a, b) => a + b, 0) / ears.length);
    }
  }
  const m = median(d);
  if (!Number.isFinite(m) || Math.abs(m) < DIRECTION_CONSTANTS.minFaceOffsetT * track.torsoT) return null;
  return m > 0 ? 1 : -1;
}

/** Lateral sign h: +1 when image-right is the racket side's positive direction (behind view, right-hander). */
export function lateralSign(view: ConfirmedCameraView, handedness: Handedness): 1 | -1 {
  const viewSign = view === 'front' ? -1 : 1;
  const handSign = handedness === 'left' ? -1 : 1;
  return (viewSign * handSign) as 1 | -1;
}
