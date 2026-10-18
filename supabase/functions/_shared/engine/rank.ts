/**
 * Stroke quality and ranking (DESIGN.md §6.2 step 12; stroke score from DESIGN-v1.0 §6.2 item 9).
 *
 * Quality (0..1) measures how well a stroke was tracked, not how well it was played:
 *   obs × min(1, conf/0.7) × (1 − coastedShare) × (ready assessable ? 1 : 0.85)
 * with obs = share of (sample, body joint) pairs observed (present and not gap-filled) on the grid over the stroke
 * span, conf = mean confidence of those observations, coastedShare = share of raw samples the tracker coasted.
 *
 * Stroke score = Σ w·c·s / Σ w·c over the measured checkpoints using that stroke's own s and c. Best = highest,
 * worst = lowest, among non-excluded strokes with quality ≥ 0.6. If none passes the gate, the non-excluded strokes
 * are ranked anyway (the clip still needs a best stroke for F1–F5). One eligible stroke → best only.
 */
import { type Joint, JOINT_INDEX } from '../contracts/common.ts';
import { FLAG_COASTED } from '../contracts/pose_v1.ts';
import { MIN_STROKE_QUALITY } from './checkpoints.ts';
import type { CheckpointRow } from './prepared_state.ts';
import { round } from './score.ts';
import { gridRange, lowerBound } from './signal_util.ts';
import type { SmoothTrack, StrokePhases } from './types.ts';

/** Body joints that matter for technique (face joints are ignored for quality). */
export const QUALITY_JOINTS: readonly Joint[] = [
  'neck',
  'root',
  'lSho',
  'rSho',
  'lElb',
  'rElb',
  'lWri',
  'rWri',
  'lHip',
  'rHip',
  'lKne',
  'rKne',
  'lAnk',
  'rAnk',
];

export const QUALITY_CONSTANTS = { confFull: 0.7, noReadyFactor: 0.85 } as const;

/** Tracking quality of one stroke over its span (see module doc). */
export function strokeQuality(track: SmoothTrack, p: StrokePhases): number {
  const range = gridRange(track, p.tStartUs, p.tEndUs);
  if (!range) return 0;
  let observed = 0, total = 0, confSum = 0;
  for (let i = range[0]; i <= range[1]; i++) {
    for (const j of QUALITY_JOINTS) {
      total++;
      const s = track.joints[j];
      if (s.x[i] === null || track.interp[i] & (1 << JOINT_INDEX[j])) continue;
      observed++;
      confSum += s.c[i];
    }
  }
  if (observed === 0) return 0;
  const raw = track.raw;
  const a = lowerBound(raw.tUs, p.tStartUs), b = lowerBound(raw.tUs, p.tEndUs + 1);
  let coasted = 0;
  for (let k = a; k < b; k++) if (raw.flags[k] & FLAG_COASTED) coasted++;
  const coastedShare = b > a ? coasted / (b - a) : 0;
  const q = (observed / total) * Math.min(1, confSum / observed / QUALITY_CONSTANTS.confFull) * (1 - coastedShare) *
    (p.readyAssessable ? 1 : QUALITY_CONSTANTS.noReadyFactor);
  return round(q, 2);
}

/** Per-stroke score from the measured rows (null when no row measured that stroke). */
export function strokeScores(
  table: readonly CheckpointRow[],
  strokeIds: readonly number[],
): Map<number, number | null> {
  const out = new Map<number, number | null>();
  for (const id of strokeIds) {
    let num = 0, den = 0;
    for (const row of table) {
      if (row.status !== 'measured') continue;
      const ps = row.perStroke.find((x) => x.strokeId === id);
      if (!ps || ps.s === null || ps.c <= 0) continue;
      num += row.weight * ps.c * ps.s;
      den += row.weight * ps.c;
    }
    out.set(id, den > 0 ? round(num / den, 4) : null);
  }
  return out;
}

export interface RankInput {
  id: number;
  quality: number;
  excluded: boolean;
  score: number | null;
}

/** Best / worst stroke ids (worst is null with fewer than two eligible strokes). */
export function rankStrokes(strokes: readonly RankInput[]): { best: number | null; worst: number | null } {
  const included = strokes.filter((s) => !s.excluded);
  const gated = included.filter((s) => s.quality >= MIN_STROKE_QUALITY);
  const pool = gated.length > 0 ? gated : included;
  if (pool.length === 0) return { best: null, worst: null };
  // Score first (unscored strokes rank below any scored one), then quality, then id.
  const sorted = [...pool].sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.quality - a.quality || a.id - b.id);
  const best = sorted[0].id;
  const worst = sorted.length >= 2 ? sorted[sorted.length - 1].id : null;
  return { best, worst };
}
