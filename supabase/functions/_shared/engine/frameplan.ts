/**
 * Step 13 (DESIGN.md §6.2, D9): key-frame requests.
 * - Crop per chosen stroke: union of the target boxes over [ready, ftStop] and the racket wrist ± racket length
 *   (1.4 T badminton, 0.8 T pickleball), expanded 1.3× about its centre, snapped to 4:3 or 3:4 in pixels (the
 *   orientation the box already has), shrunk only if it cannot fit, and shifted inside the frame. All phases of a
 *   stroke share the crop.
 * - F1–F4: best stroke at ready / bsEnd / contact / ftStop, upload.
 * - F5: overview, 2× the target box at the best stroke's contact (same snapping), upload.
 * - L1–L4: worst stroke, never uploaded. pose_only: the same frames are returned (for local evidence display) but
 *   nothing is uploaded.
 * Every `tUs` is a PhasePoint.snappedUs, i.e. a sampled, non-coasted original PTS with the racket wrist observed.
 */
import {
  BEST_FRAME_BY_PHASE,
  type FrameMode,
  type Handedness,
  type NormRect,
  OVERVIEW_FRAME_ID,
  type Sport,
  STROKE_PHASES,
  WORST_FRAME_BY_PHASE,
} from '../contracts/common.ts';
import type { FrameRequest } from '../contracts/prepare_v1.ts';
import { racketWrist } from './handedness.ts';
import { isPresent, lowerBound, nearestIndex } from './signal_util.ts';
import type { RawTrack, StrokePhases } from './types.ts';

export const RACKET_LENGTH_T: Readonly<Record<Sport, number>> = { badminton: 1.4, pickleball: 0.8 };
export const CROP_EXPAND = 1.3;
export const OVERVIEW_SCALE = 2;
const LANDSCAPE = 4 / 3;
const PORTRAIT = 3 / 4;

/** Axis-aligned box in normalized display coordinates (top-left origin). */
export interface NormBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface FramePlanInput {
  raw: RawTrack;
  phases: ReadonlyMap<number, StrokePhases>;
  best: number;
  worst: number | null;
  handedness: Handedness;
  sport: Sport;
  frameMode: FrameMode;
}

/** F1–F5 for the best stroke and L1–L4 for the worst (when there is one). */
export function planFrames(input: FramePlanInput): FrameRequest[] {
  const { raw, phases, best, worst, handedness, sport, frameMode } = input;
  const upload = frameMode === 'frames';
  const wrist = racketWrist(handedness);
  const out: FrameRequest[] = [];
  const bp = phases.get(best);
  if (!bp) throw new Error(`frame plan: unknown best stroke ${best}`);
  const bestCrop = strokeCrop(raw, bp, wrist, RACKET_LENGTH_T[sport]);
  const phaseUs = (p: StrokePhases) => ({
    ready: p.ready.snappedUs,
    bsEnd: p.bsEnd.snappedUs,
    contact: p.contact.snappedUs,
    ftStop: p.ftStop.snappedUs,
  });
  const bt = phaseUs(bp);
  for (const phase of STROKE_PHASES) {
    out.push({ frameId: BEST_FRAME_BY_PHASE[phase], strokeId: best, phase, tUs: bt[phase], crop: bestCrop, upload });
  }
  out.push({
    frameId: OVERVIEW_FRAME_ID,
    strokeId: best,
    phase: 'overview',
    tUs: bt.contact,
    crop: overviewCrop(raw, bt.contact, bestCrop),
    upload,
  });
  if (worst !== null && worst !== best) {
    const wp = phases.get(worst);
    if (!wp) throw new Error(`frame plan: unknown worst stroke ${worst}`);
    const crop = strokeCrop(raw, wp, wrist, RACKET_LENGTH_T[sport]);
    const wt = phaseUs(wp);
    for (const phase of STROKE_PHASES) {
      out.push({ frameId: WORST_FRAME_BY_PHASE[phase], strokeId: worst, phase, tUs: wt[phase], crop, upload: false });
    }
  }
  return out;
}

/** Stroke crop: target boxes ∪ wrist ± racket length over [ready, ftStop], ×1.3, snapped 4:3 / 3:4. */
export function strokeCrop(raw: RawTrack, p: StrokePhases, wrist: 'lWri' | 'rWri', racketLenT: number): NormRect {
  const a = lowerBound(raw.tUs, Math.min(p.ready.snappedUs, p.ready.tUs));
  const b = lowerBound(raw.tUs, Math.max(p.ftStop.snappedUs, p.ftStop.tUs) + 1);
  let box: NormBox | null = null;
  const rx = (racketLenT * raw.torsoT) / raw.aspect; // racket length in normalized x
  const ry = racketLenT * raw.torsoT; // … and y (frame-height units are normalized y)
  const ws = raw.joints[wrist];
  for (let k = a; k < b; k++) {
    const bb = bboxNorm(raw, k);
    if (bb) box = union(box, bb);
    if (isPresent(ws, k)) {
      const nx = (ws.x[k] as number) / raw.aspect, ny = 1 - (ws.y[k] as number);
      box = union(box, { x0: nx - rx, y0: ny - ry, x1: nx + rx, y1: ny + ry });
    }
  }
  return snapCrop(box ? scaleBox(box, CROP_EXPAND) : null, raw.display);
}

/** Overview: 2× the target box at `tUs` (nearest sample with a box); falls back to 1.5× the stroke crop. */
export function overviewCrop(raw: RawTrack, tUs: number, strokeCropRect: NormRect): NormRect {
  const k = nearestIndex(raw.tUs, tUs);
  for (let d = 0; d < raw.tUs.length; d++) {
    for (const j of [k - d, k + d]) {
      const bb = j >= 0 && j < raw.tUs.length ? bboxNorm(raw, j) : null;
      if (bb) return snapCrop(scaleBox(bb, OVERVIEW_SCALE), raw.display);
    }
  }
  const c = strokeCropRect;
  return snapCrop(scaleBox({ x0: c.x, y0: c.y, x1: c.x + c.w, y1: c.y + c.h }, 1.5), raw.display);
}

/**
 * Snaps a box to 4:3 (landscape boxes) or 3:4 (portrait) in pixels by growing the short side, shrinks it uniformly
 * if it cannot fit in the frame, then shifts it inside [0,1]². A null box becomes the largest centred crop.
 */
export function snapCrop(box: NormBox | null, display: { w: number; h: number }): NormRect {
  const W = display.w, H = display.h;
  const b = box ?? { x0: 0, y0: 0, x1: 1, y1: 1 };
  const cx = ((b.x0 + b.x1) / 2) * W, cy = ((b.y0 + b.y1) / 2) * H;
  let pw = Math.max(1, (b.x1 - b.x0) * W), ph = Math.max(1, (b.y1 - b.y0) * H);
  const ratio = pw >= ph ? LANDSCAPE : PORTRAIT;
  if (pw / ph < ratio) pw = ph * ratio;
  else ph = pw / ratio;
  const fit = Math.min(1, W / pw, H / ph);
  pw *= fit;
  ph *= fit;
  const x = Math.min(Math.max(cx - pw / 2, 0), W - pw);
  const y = Math.min(Math.max(cy - ph / 2, 0), H - ph);
  // 4 decimals; position rounded so that x + w never exceeds 1 after rounding.
  const w = round4(pw / W), h = round4(ph / H);
  return { x: clampPos(round4(x / W), w), y: clampPos(round4(y / H), h), w, h };
}

function clampPos(v: number, size: number): number {
  return Math.max(0, Math.min(v, Math.floor((1 - size) * 1e4 + 1e-6) / 1e4));
}

function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

function bboxNorm(raw: RawTrack, k: number): NormBox | null {
  const bb = raw.bboxCfs[k];
  if (!bb || bb[2] <= 0 || bb[3] <= 0) return null;
  return { x0: bb[0] / 1000, y0: bb[1] / 1000, x1: (bb[0] + bb[2]) / 1000, y1: (bb[1] + bb[3]) / 1000 };
}

function union(a: NormBox | null, b: NormBox): NormBox {
  if (!a) return { ...b };
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

/** Scales a box about its centre. */
export function scaleBox(b: NormBox, k: number): NormBox {
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  const hw = ((b.x1 - b.x0) * k) / 2, hh = ((b.y1 - b.y0) * k) / 2;
  return { x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh };
}
