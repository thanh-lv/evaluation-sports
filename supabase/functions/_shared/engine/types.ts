/**
 * Internal track representation of the analysis engine's signal stages (DESIGN.md §6.2 steps 1–9).
 *
 * Units and axes (never exported to clients; `pose.clean.json` converts back to CFS):
 * - Positions are in **frame-height units** with the origin at the bottom-left of the upright display frame:
 *   `x = cfsX/1000 · W/H` (aspect corrected) and `y = 1 − cfsY/1000` (y up).
 * - `torsoT` (T) is the median |neck − root| in frame-height units. Lengths become T by dividing by `torsoT`;
 *   velocities are already stored in **T/s**.
 * - Missing values are `null` (confidence below 0.3, Hampel outlier, or a gap longer than the fill limits).
 * - Times are integer µs on the exported clip's timeline (pose.v1 `tUs`), except refined peak times (fractional).
 *
 * Stage order: normalizePose → applyMirrorSwap → fixLimbSwaps → hampelFilter → resampleTrack → smoothTrack, then
 * handedness / segmentation / phases / direction on the smoothed grid track.
 */
import type { Handedness, Joint, PrepareRejectionCode } from '../contracts/common.ts';
import type { SkillDef } from '../rubric/types.ts';

/** One coordinate over time; `null` = missing at that sample. */
export type Series = (number | null)[];

/** One joint over time: position (frame-height units, y up) and confidence 0..1 (0 when missing). */
export interface JointSeries {
  x: Series;
  y: Series;
  c: number[];
}

/** Per-joint record keyed by the 19 Vision joints. */
export type JointMap<T> = Record<Joint, T>;

/** Analysis sampling rate (DESIGN.md D5). */
export type AnalysisHz = 30 | 60;

/** Target box `[x, y, w, h]` in CFS 0..1000 (top-left origin), copied unchanged from pose.v1. */
export type BoxCfs = [number, number, number, number];

/** Normalized track on the ORIGINAL (possibly variable-frame-rate) timestamps of pose.v1. */
export interface RawTrack {
  /** Original sampled PTS in µs, strictly increasing. */
  tUs: number[];
  /** Positions after normalization (and, later, swap fix / Hampel which return new RawTracks). */
  joints: JointMap<JointSeries>;
  /** pose.v1 tracker flags per sample (FLAG_COASTED | FLAG_REACQUIRED). */
  flags: number[];
  /** Target box per sample, CFS. */
  bboxCfs: BoxCfs[];
  /** Display aspect W/H used for the x scaling. */
  aspect: number;
  /** Composition render size in pixels. */
  display: { w: number; h: number };
  /** Torso unit T in frame-height units. */
  torsoT: number;
  /** pose.v1 `video.mirrored` (preferredTransform det < 0). */
  mirrored: boolean;
  /** True once the one-time mirrored L/R label swap has been applied (guards against a second swap). */
  mirrorSwapApplied: boolean;
}

/** Track resampled onto the uniform grid `tUs[i] = t0Us + round(i·1e6/hz)` (DESIGN.md §6.2 step 4). */
export interface GridTrack {
  hz: AnalysisHz;
  t0Us: number;
  /** Uniform grid times in µs. */
  tUs: number[];
  /** Grid step in seconds (1/hz). */
  dtS: number;
  /** Resampled positions; after smoothTrack these are the SG-smoothed positions. */
  joints: JointMap<JointSeries>;
  /** 19-bit mask per grid sample: bit j set ⇔ JOINT_ORDER[j] was gap-filled (not observed) there. */
  interp: number[];
  /** Tracker flags of the original samples, OR-ed onto their nearest grid sample. */
  flags: number[];
  torsoT: number;
  aspect: number;
  /** The cleaned raw track this grid was built from (for PTS snapping and raw-window checks). */
  raw: RawTrack;
}

/** Per-joint velocity on the grid, in T/s (x right, y up). */
export interface JointVelocity {
  vx: Series;
  vy: Series;
  speed: Series;
}

/** Savitzky–Golay smoothed grid track with SG-derivative velocities (DESIGN.md §6.2 step 5). */
export interface SmoothTrack extends GridTrack {
  vel: JointMap<JointVelocity>;
  /** SG window length used (5 at 30 Hz, 9 at 60 Hz). */
  sgWindow: number;
}

/** Skill parameters segmentation needs; taken from the rubric SkillDef, never hard-coded. */
export type SegmentParams = Pick<SkillDef, 'vmin' | 'nms' | 'contactOffsetMs'>;

/** Why a speed-peak candidate did not become a stroke. */
export type CandidateRejection =
  | 'below_threshold'
  | 'low_prominence'
  | 'nms'
  | 'wrist_missing'
  | 'reacquired'
  | 'interpolated'
  | 'over_limit';

/** A local maximum of the dominant-wrist speed considered by segmentation. */
export interface StrokeCandidate {
  /** Grid index of the sampled maximum. */
  index: number;
  /** Parabolically refined peak time (fractional µs). */
  tPeakUs: number;
  /** Parabolically refined peak speed (T/s). */
  vPeak: number;
  /** Topographic prominence of the peak (T/s). */
  prominence: number;
  /** null when accepted. */
  rejected: CandidateRejection | null;
}

/** An accepted stroke (ids 1..n in time order). */
export interface DetectedStroke {
  id: number;
  /** Grid index of the sampled speed maximum. */
  peakIndex: number;
  /** Refined peak time (fractional µs). */
  tPeakUs: number;
  /** Refined peak dominant-wrist speed (T/s). */
  vPeak: number;
  /** `round(tPeakUs + contactOffsetMs·1000)`, clamped into the track; an estimate (DESIGN.md D7). */
  tContactUs: number;
  contactIsEstimate: true;
}

/** Segmentation outcome; zero strokes is a 422 `no_strokes_detected`. */
export type SegmentResult =
  | { ok: true; strokes: DetectedStroke[]; candidates: StrokeCandidate[]; threshold: number }
  | { ok: false; code: 'no_strokes_detected'; candidates: StrokeCandidate[]; threshold: number };

/** One phase instant: engine time, nearest grid index, and the PTS-snapped time for frame requests. */
export interface PhasePoint {
  /** Engine time in µs (grid time, or the fractional contact estimate). */
  tUs: number;
  /** Nearest grid index (use for metrics). */
  index: number;
  /** Nearest sampled, non-interpolated original PTS (use for frame requests / UI). */
  snappedUs: number;
}

/** Grid window [startIndex, endIndex] inclusive with its µs bounds. */
export interface GridWindow {
  startIndex: number;
  endIndex: number;
  startUs: number;
  endUs: number;
}

/** Engine phases of one stroke (DESIGN-v1.0 §6.2 step 5, snapping per DESIGN.md §6.2 step 8). */
export interface StrokePhases {
  strokeId: number;
  swingStart: PhasePoint | null;
  /** Representative ready frame (closest to the window's median pose), or a fallback when not assessable. */
  ready: PhasePoint;
  /** Window over which the ready pose is the median; null when < 0.2 s remained (ready not assessed). */
  readyWindow: GridWindow | null;
  readyAssessable: boolean;
  bsEnd: PhasePoint;
  contact: PhasePoint;
  ftStop: PhasePoint;
  /** null when contact + 1 s is past the end of the track. */
  recovery: PhasePoint | null;
  /** Stroke span (snapped PTS): earliest of ready window / swingStart / phase frames … recovery ?? ftStop. */
  tStartUs: number;
  tEndUs: number;
}

/** Hitting-direction sign `f` (+1 = toward image-right) and how it was decided. */
export interface DirectionResult {
  f: 1 | -1;
  source: 'wrist' | 'face' | 'default';
  votes: { pos: number; neg: number; abstain: number };
}

/** Handedness check outcome (DESIGN.md §6.2 step 6). */
export interface HandednessResult {
  /** The other hand when ≥ 4 of the top-5 wrist-speed peaks belong to it; otherwise null. */
  suggestion: Handedness | null;
  /** The peaks considered, strongest first. */
  peaks: { wrist: 'lWri' | 'rWri'; index: number; speed: number }[];
}

/** A prepare-time rejection raised by the engine (mapped to HTTP 422 by the handler). */
export class EngineRejection extends Error {
  /** One of PREPARE_REJECTION_CODES. */
  readonly code: PrepareRejectionCode;
  constructor(code: PrepareRejectionCode, message?: string) {
    super(message ?? code);
    this.name = 'EngineRejection';
    this.code = code;
  }
}
