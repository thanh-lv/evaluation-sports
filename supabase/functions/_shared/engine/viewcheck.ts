/**
 * Step 11 (DESIGN.md §6.2; DESIGN-v1.0 §6.2 item 8): camera view guess. Only produces `viewGuess` and warnings;
 * scoring always uses the confirmed view.
 *
 * - Width: r = median shoulder width / T in the ready frames ÷ SWmax (floored at the anatomical prior, so a side
 *   clip whose player never turns still reads narrow). r < 0.35 → side; r > 0.75 → behind or front; else diagonal.
 * - Behind vs front: a face vote (nose and an eye observed: front) weighted 0.6 and a shoulder-order vote
 *   (racket-independent: anatomical right shoulder on image left means the player faces the camera; flipped for a
 *   mirrored source) weighted 0.4. DESIGN.md also mentions hip-line motion; it is not used because it needs
 *   footwork the launch skills do not have (serves and dinks barely move the hips).
 * Confidence = how far r sits inside its band (0.5 at a boundary, 1 deep inside; diagonal capped at 0.85), times
 * the front/behind certainty for those two views.
 */
import type { ConfirmedCameraView } from '../contracts/common.ts';
import { maxWidths, pt } from './metrics.ts';
import { median } from './signal_util.ts';
import type { SmoothTrack, StrokePhases } from './types.ts';

export const VIEW_CONSTANTS = {
  sideBelow: 0.35,
  squareAbove: 0.75,
  fullConfDepth: 0.2,
  diagonalMaxConf: 0.85,
  faceWeight: 0.6,
  lowConfidence: 0.7,
} as const;

export interface ViewGuess {
  view: ConfirmedCameraView;
  confidence: number;
}

export function guessView(track: SmoothTrack, phases: readonly StrokePhases[], mirrored: boolean): ViewGuess {
  const C = VIEW_CONSTANTS;
  const idx: number[] = [];
  for (const p of phases) {
    if (!p.readyWindow) continue;
    for (let i = p.readyWindow.startIndex; i <= p.readyWindow.endIndex; i++) idx.push(i);
  }
  if (idx.length === 0) { for (let i = 0; i < track.tUs.length; i++) idx.push(i); }

  const T = track.torsoT;
  const sw: number[] = [];
  let face = 0, faceN = 0, facing = 0, facingN = 0;
  for (const i of idx) {
    const l = pt(track, 'lSho', i), r = pt(track, 'rSho', i);
    if (l && r) {
      sw.push(Math.abs(l.x - r.x) / T);
      facingN++;
      if ((r.x - l.x) * (mirrored ? -1 : 1) < 0) facing++;
    }
    faceN++;
    if (pt(track, 'nose', i) && (pt(track, 'lEye', i) || pt(track, 'rEye', i))) face++;
  }
  const swMax = maxWidths(track).sw;
  const ratio = sw.length ? median(sw) / swMax : 0;
  const depthConf = (d: number) => 0.5 + 0.5 * Math.min(1, Math.max(0, d) / C.fullConfDepth);

  if (ratio < C.sideBelow) return { view: 'side', confidence: round2(depthConf(C.sideBelow - ratio)) };
  if (ratio <= C.squareAbove) {
    const d = Math.min(ratio - C.sideBelow, C.squareAbove - ratio);
    return { view: 'diagonal', confidence: round2(Math.min(C.diagonalMaxConf, depthConf(d))) };
  }
  const pFace = faceN ? face / faceN : 0.5;
  const pFacing = facingN ? facing / facingN : 0.5;
  const front = C.faceWeight * pFace + (1 - C.faceWeight) * pFacing;
  const certainty = Math.abs(front - 0.5) * 2;
  return {
    view: front > 0.5 ? 'front' : 'behind',
    confidence: round2(depthConf(ratio - C.squareAbove) * (0.5 + 0.5 * certainty)),
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
