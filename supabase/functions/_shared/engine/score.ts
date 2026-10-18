/**
 * Scoring (DESIGN.md §6.4, rules from DESIGN-v1.0 §6.4 without hysteresis). Pure.
 *
 * - Metric: s = 1 inside [lo, hi], else max(0, 1 − d/tol) with d the distance to the nearer bound; booleans 1 / 0.
 * - Checkpoint: s = median over valid strokes (mean with only 1–2, confidence halved); booleans use the mean (share
 *   of strokes that got it right) because a median of 0/1 values throws the minority away.
 *   c = min(1, meanJointConf/0.6) × viewFactor × (velocityBased at 30 Hz ? 0.5 : 1).
 * - V checkpoint (after Claude): s = level/4, c = {low .4, medium .7, high 1} × viewFactor; level −1 excludes it.
 *   The V share of each sub-score's effective weight Σw·c is capped at 35 % by scaling the V items down.
 * - Sub-score: 100·Σ(w·c·s)/Σ(w·c), coverage = Σ(w·c)/Σw over its scorable checkpoints (M, M~, V; N never counts),
 *   shown when coverage ≥ 0.4.
 * - Overall: skill-weighted over the shown sub-scores; coverage = skill-weighted mean of sub-score coverages.
 *   coverage < 0.5 → partial (no number); coverage < 0.8 → capped at 85. Display = round(x/5)·5. Level bands
 *   0–39 / 40–59 / 60–79 / 80–100 from the (capped) raw overall, no hysteresis.
 */
import { type Level, SUB_SCORE_KEYS, type SubScoreKey } from '../contracts/common.ts';
import type { Confidence } from '../contracts/coach_output.ts';
import type { SkillDef } from '../rubric/types.ts';
import type { CheckpointRow, MetricTarget, Reading, SubScorePreview } from './prepared_state.ts';

export const SCORE_CONSTANTS = {
  confFull: 0.6,
  hz30VelocityFactor: 0.5,
  fewStrokesMax: 2,
  fewStrokesFactor: 0.5,
  vShareMax: 0.35,
  subScoreMinCoverage: 0.4,
  partialBelow: 0.5,
  capBelow: 0.8,
  capScore: 85,
} as const;

export const VISUAL_CONFIDENCE: Readonly<Record<Confidence, number>> = { low: 0.4, medium: 0.7, high: 1.0 };

/** Score of one metric value against its target. Null value → null. */
export function scoreMetric(value: number | boolean | null, target: MetricTarget, tol: number): number | null {
  if (value === null) return null;
  if (typeof target === 'boolean') return (typeof value === 'boolean' ? value : value !== 0) === target ? 1 : 0;
  if (typeof value !== 'number') return null;
  const [lo, hi] = target;
  let d = 0;
  if (lo !== null && value < lo) d = lo - value;
  else if (hi !== null && value > hi) d = value - hi;
  if (d === 0) return 1;
  return tol > 0 ? Math.max(0, 1 - d / tol) : 0;
}

/** Which side of the target a value falls on (picks the fault and the plain template). */
export function readingOf(value: number | boolean | null, target: MetricTarget | null): Reading | null {
  if (value === null || target === null) return null;
  if (typeof target === 'boolean' || typeof value === 'boolean') {
    const b = typeof value === 'boolean' ? value : value !== 0;
    if (typeof target === 'boolean') return b === target ? 'true' : 'false';
    return b ? 'true' : 'false';
  }
  const [lo, hi] = target;
  if (lo !== null && value < lo) return 'low';
  if (hi !== null && value > hi) return 'high';
  return 'ok';
}

/** Checkpoint confidence from the mean joint confidence (D8 gate already applied upstream). */
export function checkpointConfidence(meanJointConf: number, viewFactor: number, velocityBased: boolean, hz: number) {
  const hzF = velocityBased && hz === 30 ? SCORE_CONSTANTS.hz30VelocityFactor : 1;
  return Math.min(1, meanJointConf / SCORE_CONSTANTS.confFull) * viewFactor * hzF;
}

/** Median (odd/even) of a non-empty list. */
function median(v: readonly number[]): number {
  const a = [...v].sort((p, q) => p - q);
  const n = a.length;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

function mean(v: readonly number[]): number {
  return v.reduce((a, b) => a + b, 0) / v.length;
}

/**
 * Aggregates valid per-stroke scores and joint confidences into the checkpoint (s, c). `boolean` switches the s
 * aggregate to the mean. Returns null when there is no valid stroke.
 */
export function aggregateStrokes(
  perStroke: readonly { s: number; conf: number }[],
  opts: { viewFactor: number; velocityBased: boolean; hz: number; boolean: boolean },
): { s: number; c: number } | null {
  const n = perStroke.length;
  if (n === 0) return null;
  const ss = perStroke.map((p) => p.s);
  const few = n <= SCORE_CONSTANTS.fewStrokesMax;
  const s = opts.boolean || few ? mean(ss) : median(ss);
  let c = checkpointConfidence(mean(perStroke.map((p) => p.conf)), opts.viewFactor, opts.velocityBased, opts.hz);
  if (few) c *= SCORE_CONSTANTS.fewStrokesFactor;
  return { s, c };
}

/** Display rounding: round(x/5)·5, clamped to 0..100. */
export function displayScore(x: number): number {
  return Math.min(100, Math.max(0, Math.round(x / 5) * 5));
}

/** Level band of a raw overall score (DESIGN.md §6.4; no hysteresis). */
export function levelFor(score: number): Level {
  if (score < 40) return 'beginner';
  if (score < 60) return 'improving';
  if (score < 80) return 'intermediate';
  return 'advanced';
}

/** Claude's (post-processed) verdict on one V checkpoint. */
export interface VisualJudgmentInput {
  checkpointId: string;
  /** −1..4; −1 = not assessable. */
  level: number;
  confidence: Confidence;
}

/** A checkpoint row after composition: V rows carry the judged s / c. */
export interface ComposedCheckpoint extends CheckpointRow {
  /** Effective weight w·c after the V-share cap (0 when not scored). */
  effectiveWeight: number;
  /** Judged level for V rows (null otherwise or when −1 / missing). */
  visualLevel: number | null;
}

export interface ComposedSubScore {
  key: SubScoreKey;
  weight: number;
  /** Raw 0..100, null when nothing was scored. */
  score: number | null;
  /** Rounded to 5 when shown, else null. */
  displayScore: number | null;
  coverage: number;
  confidence: Confidence;
  shown: boolean;
  /** Scale applied to the V items to respect the 35 % share (1 = no cap). */
  vScale: number;
}

export interface ComposedOverall {
  /** Raw overall after the 85 cap; null when partial. */
  score: number | null;
  displayScore: number | null;
  level: Level | null;
  coverage: number;
  partial: boolean;
  capped: boolean;
}

export interface ComposedScores {
  checkpoints: ComposedCheckpoint[];
  subScores: ComposedSubScore[];
  overall: ComposedOverall;
}

/** Statuses that count in a sub-score's Σw (everything scorable; N never does). */
function countsInCoverage(row: CheckpointRow): boolean {
  return row.status !== 'not_assessable';
}

/**
 * Final composition after Claude (DESIGN.md §8.4 step 9). `visualJudgments` must already be normalised by
 * postprocess (this skill's V ids, level clamped to −1..4; pose_only forced to −1). Unknown ids are ignored.
 */
export function composeScores(
  checkpointTable: readonly CheckpointRow[],
  visualJudgments: readonly VisualJudgmentInput[],
  skill: Pick<SkillDef, 'weights'>,
): ComposedScores {
  const byId = new Map(visualJudgments.map((v) => [v.checkpointId, v]));
  const rows: ComposedCheckpoint[] = checkpointTable.map((row) => {
    if (row.status !== 'visual') {
      return { ...row, effectiveWeight: row.status === 'measured' ? row.weight * row.c : 0, visualLevel: null };
    }
    const j = byId.get(row.id);
    if (!j || j.level < 0 || row.viewFactor === 0) return { ...row, effectiveWeight: 0, visualLevel: null };
    const level = Math.min(4, Math.round(j.level));
    const s = level / 4;
    const c = VISUAL_CONFIDENCE[j.confidence] * row.viewFactor;
    return { ...row, s, c, effectiveWeight: row.weight * c, visualLevel: level };
  });
  const subScores = SUB_SCORE_KEYS.map((key) => composeSubScore(key, rows, skill.weights[key]));
  return { checkpoints: rows, subScores, overall: composeOverall(subScores) };
}

function composeSubScore(key: SubScoreKey, rows: ComposedCheckpoint[], weight: number): ComposedSubScore {
  const mine = rows.filter((r) => r.subscore === key && countsInCoverage(r));
  const sumW = mine.reduce((a, r) => a + r.weight, 0);
  const measured = mine.filter((r) => r.status === 'measured' && r.effectiveWeight > 0);
  const visual = mine.filter((r) => r.status === 'visual' && r.effectiveWeight > 0);
  const mW = measured.reduce((a, r) => a + r.effectiveWeight, 0);
  const vW = visual.reduce((a, r) => a + r.effectiveWeight, 0);
  // Cap: k·vW ≤ share·(mW + k·vW)  ⇔  k ≤ share·mW / ((1 − share)·vW). With nothing measured, V cannot score alone.
  const share = SCORE_CONSTANTS.vShareMax;
  const vScale = vW > 0 && vW > (share / (1 - share)) * mW ? ((share / (1 - share)) * mW) / vW : 1;
  for (const r of visual) r.effectiveWeight *= vScale;
  const scored = [...measured, ...visual].filter((r) => r.effectiveWeight > 0);
  const eff = scored.reduce((a, r) => a + r.effectiveWeight, 0);
  const coverage = sumW > 0 ? Math.min(1, eff / sumW) : 0;
  const score = eff > 0 ? (100 * scored.reduce((a, r) => a + r.effectiveWeight * (r.s as number), 0)) / eff : null;
  const shown = score !== null && coverage >= SCORE_CONSTANTS.subScoreMinCoverage;
  // Confidence label: weight-averaged checkpoint confidence of what was scored.
  const meanC = eff > 0 ? scored.reduce((a, r) => a + r.effectiveWeight * r.c, 0) / eff : 0;
  const confidence: Confidence = meanC >= 0.75 ? 'high' : meanC >= 0.5 ? 'medium' : 'low';
  return {
    key,
    weight,
    score,
    displayScore: shown ? displayScore(score as number) : null,
    coverage,
    confidence,
    shown,
    vScale,
  };
}

function composeOverall(subs: readonly ComposedSubScore[]): ComposedOverall {
  const weighted = subs.filter((s) => s.weight > 0);
  const sumW = weighted.reduce((a, s) => a + s.weight, 0);
  const coverage = sumW > 0 ? weighted.reduce((a, s) => a + s.weight * s.coverage, 0) / sumW : 0;
  const shown = weighted.filter((s) => s.shown);
  const shownW = shown.reduce((a, s) => a + s.weight, 0);
  if (coverage < SCORE_CONSTANTS.partialBelow || shownW === 0) {
    return { score: null, displayScore: null, level: null, coverage, partial: true, capped: false };
  }
  let score = shown.reduce((a, s) => a + s.weight * (s.score as number), 0) / shownW;
  let capped = false;
  if (coverage < SCORE_CONSTANTS.capBelow && score > SCORE_CONSTANTS.capScore) {
    score = SCORE_CONSTANTS.capScore;
    capped = true;
  }
  return { score, displayScore: displayScore(score), level: levelFor(score), coverage, partial: false, capped };
}

/** Sub-scores from measured checkpoints only (prepare time, before Claude). */
export function previewSubScores(
  checkpointTable: readonly CheckpointRow[],
  skill: Pick<SkillDef, 'weights'>,
): { subScores: SubScorePreview[]; coverage: number } {
  const composed = composeScores(checkpointTable, [], skill);
  return {
    subScores: composed.subScores.map((s) => ({
      key: s.key,
      weight: s.weight,
      score: s.score === null ? null : round(s.score, 1),
      coverage: round(s.coverage, 3),
      shown: s.shown,
    })),
    coverage: round(composed.overall.coverage, 3),
  };
}

/** Round to n decimals (stable JSON for golden files). */
export function round(x: number, n: number): number {
  const f = 10 ** n;
  return Math.round(x * f) / f;
}
