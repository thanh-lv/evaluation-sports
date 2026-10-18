/**
 * Step 7 (DESIGN.md §6.2): stroke segmentation on v(t), the racket-wrist speed (T/s) of the smoothed grid track.
 *
 * 1. Candidates: local maxima with v ≥ max(vmin, 2.5·median(v)) and prominence ≥ 0.4·peak.
 * 2. Non-max suppression with the skill's spacing (strongest first). NMS runs before the quality checks so a
 *    rejected stroke cannot be replaced by its own shoulder peak.
 * 3. Quality rejection: racket wrist missing in > 30% of ±0.2 s (counted on the raw timeline against the expected
 *    sample count, so dropped frames count as missing), a tracker re-acquisition in ±0.2 s, or > 50% gap-filled grid
 *    samples in ±0.1 s.
 * 4. Parabolic peak refinement; contact = refined peak + `contactOffsetMs` (an estimate, DESIGN.md D7).
 * 5. At most MAX_STROKES (strongest kept), ids 1..n in time order; zero strokes → `no_strokes_detected`.
 * Thresholds come from the rubric SkillDef (`vmin`, `nms`, `contactOffsetMs`).
 */
import { type Handedness, JOINT_INDEX } from '../contracts/common.ts';
import { FLAG_REACQUIRED } from '../contracts/pose_v1.ts';
import { MAX_STROKES } from '../contracts/prepare_v1.ts';
import { racketWrist } from './handedness.ts';
import {
  clamp,
  gridRange,
  isPresent,
  localMaxima,
  lowerBound,
  median,
  medianIntervalUs,
  parabolicPeak,
  present,
  prominence,
} from './signal_util.ts';
import type {
  CandidateRejection,
  DetectedStroke,
  SegmentParams,
  SegmentResult,
  SmoothTrack,
  StrokeCandidate,
} from './types.ts';

/** Fixed segmentation constants (the per-skill ones live in the rubric). */
export const SEGMENT_CONSTANTS = {
  medianFactor: 2.5,
  minProminenceFrac: 0.4,
  missingWindowUs: 200_000,
  maxMissingFrac: 0.3,
  interpWindowUs: 100_000,
  maxInterpFrac: 0.5,
} as const;

/** Segments strokes from the racket-wrist speed. */
export function segmentStrokes(
  track: SmoothTrack,
  handedness: Handedness,
  params: SegmentParams,
  maxStrokes: number = MAX_STROKES,
): SegmentResult {
  const C = SEGMENT_CONSTANTS;
  const wrist = racketWrist(handedness);
  const v = track.vel[wrist].speed;
  const threshold = Math.max(params.vmin, C.medianFactor * (median(present(v)) || 0));

  const candidates: StrokeCandidate[] = localMaxima(v).map((index) => {
    const { delta, value } = parabolicPeak(v, index);
    return {
      index,
      tPeakUs: track.tUs[index] + delta * track.dtS * 1e6,
      vPeak: value,
      prominence: prominence(v, index),
      rejected: null as CandidateRejection | null,
    };
  });
  for (const c of candidates) {
    const peak = v[c.index] as number;
    if (peak < threshold) c.rejected = 'below_threshold';
    else if (c.prominence < C.minProminenceFrac * peak) c.rejected = 'low_prominence';
  }

  // NMS, strongest first.
  const nmsUs = params.nms * 1e6;
  const byStrength = candidates.filter((c) => !c.rejected).sort((a, b) => b.vPeak - a.vPeak);
  const kept: StrokeCandidate[] = [];
  for (const c of byStrength) {
    if (kept.some((k) => Math.abs(k.tPeakUs - c.tPeakUs) < nmsUs)) c.rejected = 'nms';
    else kept.push(c);
  }

  for (const c of kept) c.rejected = qualityRejection(track, wrist, c.index);
  const good = kept.filter((c) => !c.rejected);
  good.slice(maxStrokes).forEach((c) => (c.rejected = 'over_limit'));
  const accepted = good.slice(0, maxStrokes).sort((a, b) => a.tPeakUs - b.tPeakUs);

  if (accepted.length === 0) return { ok: false, code: 'no_strokes_detected', candidates, threshold };
  const tMin = track.tUs[0];
  const tMax = track.tUs[track.tUs.length - 1];
  const strokes: DetectedStroke[] = accepted.map((c, k) => ({
    id: k + 1,
    peakIndex: c.index,
    tPeakUs: c.tPeakUs,
    vPeak: c.vPeak,
    tContactUs: Math.round(clamp(c.tPeakUs + params.contactOffsetMs * 1000, tMin, tMax)),
    contactIsEstimate: true,
  }));
  return { ok: true, strokes, candidates, threshold };
}

/** Quality checks of DESIGN.md §6.2 step 7 around a candidate peak; null when the candidate is usable. */
export function qualityRejection(
  track: SmoothTrack,
  wrist: 'lWri' | 'rWri',
  index: number,
): CandidateRejection | null {
  const C = SEGMENT_CONSTANTS;
  const raw = track.raw;
  const t = track.tUs[index];
  const lo = lowerBound(raw.tUs, t - C.missingWindowUs);
  const hi = lowerBound(raw.tUs, t + C.missingWindowUs + 1);
  let observed = 0;
  for (let k = lo; k < hi; k++) {
    if (raw.flags[k] & FLAG_REACQUIRED) return 'reacquired';
    if (isPresent(raw.joints[wrist], k)) observed++;
  }
  // Expected raw samples in the window at the source's nominal sampling rate (VFR drops count as missing). The rate
  // is the analysis rate unless the raw samples are sparser (a 30 fps source sent with analysisHz 60 would otherwise
  // read as half missing and lose every stroke).
  const expected = (2 * C.missingWindowUs * nominalRawHz(track)) / 1e6 + 1;
  if (1 - observed / expected > C.maxMissingFrac) return 'wrist_missing';

  const range = gridRange(track, t - C.interpWindowUs, t + C.interpWindowUs);
  if (range) {
    const bit = 1 << JOINT_INDEX[wrist];
    let filled = 0;
    for (let i = range[0]; i <= range[1]; i++) if (track.interp[i] & bit || track.joints[wrist].x[i] === null) filled++;
    if (filled / (range[1] - range[0] + 1) > C.maxInterpFrac) return 'interpolated';
  }
  return null;
}

/** Sampling rate of the raw track: the analysis rate, or lower when the median raw interval is longer. */
function nominalRawHz(track: SmoothTrack): number {
  const dt = medianIntervalUs(track.raw.tUs);
  return Number.isFinite(dt) && dt > 0 ? Math.min(track.hz, 1e6 / dt) : track.hz;
}
