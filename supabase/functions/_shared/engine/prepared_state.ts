/**
 * `prepared.v1`: the engine state stored in `analyses.prepared` (jsonb) by `POST /analyze/prepare` and consumed by
 * the Claude module (`<checkpoints>`, `<strokes>`, `<candidates>`, `<visual_to_judge>`) and by the compose step
 * (`composeScores` in score.ts, after Claude has judged the V checkpoints).
 *
 * Everything numeric here is owned by code (DESIGN.md D2). Values are internal: clients never read this document
 * (column grants hide `analyses.prepared`); the display-safe projection is coach-result.v1.
 *
 * Units: metric values use the rubric unit of their checkpoint (deg, T = torso length, ratio, T/s, bool/event);
 * times are µs on the clip timeline and every phase/frame time is a sampled PTS.
 */
import { z } from 'zod';
import {
  ConfirmedCameraView,
  FrameMode,
  Handedness,
  Joint,
  LocalizedText,
  LowerUuid,
  MicroSeconds,
  SkillId,
  Sport,
  SubScoreKey,
  UploadFrameId,
} from '../contracts/common.ts';
import { PoseQuality } from '../contracts/pose_v1.ts';
import { FrameRequest, PrepareWarning, StrokeRole } from '../contracts/prepare_v1.ts';
import { ASSESS_TAGS, CHECKPOINT_PHASES } from '../rubric/types.ts';

/** Bumped whenever an engine change can move a number (stored as `analyses.algo_version`). */
export const ALGO_VERSION = 'engine-1.1.0';
export const PREPARED_SCHEMA = 'prepared.v1';

const Unit = z.number().min(0).max(1);
const MetricScalar = z.union([z.number(), z.boolean()]);
/** Numeric band [lo, hi] (null = open side) or the expected boolean / event presence. */
export const MetricTarget = z.union([z.tuple([z.number().nullable(), z.number().nullable()]), z.boolean()]);
export type MetricTarget = z.infer<typeof MetricTarget>;

/**
 * Where an aggregated reading sits relative to the target: below / above the band, inside it, or a boolean that
 * came out false / true. For bands it picks the fault (`FaultDef.when`) and the plain template (`plain.low|high`,
 * `plain.ok` inside the band); weakness candidates carry their own resolved side (see candidates.ts).
 */
export const READINGS = ['low', 'high', 'ok', 'false', 'true'] as const;
export const Reading = z.enum(READINGS);
export type Reading = z.infer<typeof Reading>;

/**
 * Row status:
 * - `measured`: M / M~ with at least one valid stroke and a non-zero view factor (s and c set);
 * - `visual`: V, awaiting Claude's judgment (s null, c 0 until composeScores; counts in Σw only once judged 0..4);
 * - `view_excluded`: view factor 0 for the confirmed view (excluded: never scored, not in Σw);
 * - `no_data`: measurable in this view but no valid stroke produced a value (counts in Σw with c = 0);
 * - `not_assessable`: assess N (never scored, never counted).
 */
export const CHECKPOINT_STATUSES = ['measured', 'visual', 'view_excluded', 'no_data', 'not_assessable'] as const;
export const CheckpointStatus = z.enum(CHECKPOINT_STATUSES);
export type CheckpointStatus = z.infer<typeof CheckpointStatus>;

export const PerStrokeMetric = z.object({
  strokeId: z.number().int().positive(),
  value: MetricScalar.nullable(),
  /** Metric score 0..1 for this stroke; null when the value is missing. */
  s: Unit.nullable(),
  /** Per-stroke confidence: min(1, jointConf/0.6) × viewFactor × hz factor (no few-stroke halving). */
  c: Unit,
  /** True when this stroke entered the checkpoint aggregate (not excluded, quality gate, value present). */
  used: z.boolean(),
});
export type PerStrokeMetric = z.infer<typeof PerStrokeMetric>;

export const CheckpointRow = z.object({
  id: z.string(),
  subscore: SubScoreKey,
  assess: z.enum(ASSESS_TAGS),
  weight: z.union([z.literal(1), z.literal(2)]),
  phase: z.enum(CHECKPOINT_PHASES),
  /** Metric registry key (M / M~ only). */
  metricKey: z.string().nullable(),
  unit: z.string().nullable(),
  status: CheckpointStatus,
  /** Aggregated score 0..1 (median over valid strokes; mean for booleans); null unless measured. */
  s: Unit.nullable(),
  /** Confidence 0..1 including the view factor, the 30 Hz halving and the 1–2 stroke halving. */
  c: Unit,
  /** Aggregated value (median of numbers; share of true strokes for booleans is in valueText). */
  value: MetricScalar.nullable(),
  target: MetricTarget.nullable(),
  tol: z.number().nullable(),
  reading: Reading.nullable(),
  /** Language-neutral display text, e.g. "142°", "0.45 T", "3/4". */
  valueText: z.string(),
  /** e.g. "≥ 150°", "10–30°", "≤ 0.30 T", "✓". */
  targetText: z.string(),
  perStroke: z.array(PerStrokeMetric),
  /** Overlay joints, already mirrored for left-handers (the rubric is written for right-handers). */
  joints: z.array(Joint),
  viewFactor: z.number().min(0).max(1),
  velocityBased: z.boolean(),
  injuryFlag: z.boolean(),
  validStrokes: z.number().int().nonnegative(),
});
export type CheckpointRow = z.infer<typeof CheckpointRow>;

export const PreparedStrokeState = z.object({
  id: z.number().int().positive(),
  tStartUs: MicroSeconds,
  /** Contact estimate (peak + contactOffsetMs), clamped into [tStartUs, tEndUs]. */
  tContactUs: MicroSeconds,
  contactIsEstimate: z.boolean(),
  tEndUs: MicroSeconds,
  /** Refined peak racket-wrist speed (T/s, after SG smoothing). */
  vPeak: z.number().nonnegative(),
  /** All engine phases as snapped PTS. */
  phases: z.object({
    swingStart: MicroSeconds.nullable(),
    ready: MicroSeconds,
    bsEnd: MicroSeconds,
    contact: MicroSeconds,
    ftStop: MicroSeconds,
    recovery: MicroSeconds.nullable(),
  }),
  readyAssessable: z.boolean(),
  quality: Unit,
  role: StrokeRole,
  excluded: z.boolean(),
  /** Σ w·c·s / Σ w·c over the measured checkpoints for this stroke; null when nothing was measurable. */
  strokeScore: Unit.nullable(),
  /** Per-checkpoint metric values of this stroke (checkpoint id → value), M / M~ only. */
  metrics: z.record(z.string(), MetricScalar.nullable()),
});
export type PreparedStrokeState = z.infer<typeof PreparedStrokeState>;

export const VisualToJudge = z.object({
  checkpointId: z.string(),
  phase: z.enum(CHECKPOINT_PHASES),
  /** Level 0..4 anchors (EN), copied from the rubric. */
  anchors: z.array(z.string()).length(5),
  /** Uploaded frames that show this phase; empty in pose_only mode (Claude must answer −1). */
  frameIds: z.array(UploadFrameId),
  viewFactor: z.number().min(0).max(1),
});
export type VisualToJudge = z.infer<typeof VisualToJudge>;

export const WeaknessCandidate = z.object({
  checkpointId: z.string(),
  /** Fault whose `when` matches `reading`; null when the rubric has none for that side. */
  faultId: z.string().nullable(),
  /** The side the checkpoint missed on: low / high (bands) or false (booleans). */
  reading: z.enum(['low', 'high', 'false']),
  /** W_sub · w · (1 − s) · c with W_sub the skill weight / 100. */
  impact: z.number().nonnegative(),
  s: Unit,
  c: Unit,
  /** Catalog evidence template for that side (`plain.low|high`; `false` → `low`), no digits. */
  plain: LocalizedText,
});
export type WeaknessCandidate = z.infer<typeof WeaknessCandidate>;

export const StrengthCandidate = z.object({
  checkpointId: z.string(),
  /** W_sub · w · c (ranking key). */
  rank: z.number().nonnegative(),
  s: Unit,
  c: Unit,
  /** Catalog evidence template for a met target (`plain.ok`), no digits. */
  plain: LocalizedText,
});
export type StrengthCandidate = z.infer<typeof StrengthCandidate>;

/** Injury-flagged checkpoint that reads as a weakness: becomes the fixed `CheckpointDef.safety` note. */
export const InjuryFlagHit = z.object({ checkpointId: z.string(), s: Unit, c: Unit });
export type InjuryFlagHit = z.infer<typeof InjuryFlagHit>;

export const Candidates = z.object({
  weaknesses: z.array(WeaknessCandidate).max(6),
  strengths: z.array(StrengthCandidate).max(6),
  injury: z.array(InjuryFlagHit),
});
export type Candidates = z.infer<typeof Candidates>;

export const SubScorePreview = z.object({
  key: SubScoreKey,
  /** Skill weight 0..100. */
  weight: z.number().nonnegative(),
  /** Raw 0..100 from measured checkpoints only; null when nothing measured. */
  score: z.number().min(0).max(100).nullable(),
  coverage: Unit,
  /** coverage ≥ 0.4. */
  shown: z.boolean(),
});
export type SubScorePreview = z.infer<typeof SubScorePreview>;

const PreparedObject = z.object({
  schema: z.literal(PREPARED_SCHEMA),
  analysisId: LowerUuid,
  algoVersion: z.string(),
  /** Rubric version the numbers were computed with (bundle version, or the sha256 the caller passed). */
  rubricVersion: z.string(),
  sport: Sport,
  skill: SkillId,
  /** Confirmed view used for scoring (user's choice, or viewGuess when the pose said `auto`). */
  view: ConfirmedCameraView,
  viewSource: z.enum(['user', 'guess']),
  viewGuess: z.object({ view: ConfirmedCameraView, confidence: Unit }),
  handedness: Handedness,
  handednessSuggestion: Handedness.nullable(),
  /** Hitting-direction sign in image space and how it was decided. */
  direction: z.object({ f: z.union([z.literal(1), z.literal(-1)]), source: z.enum(['wrist', 'face', 'default']) }),
  analysisHz: z.union([z.literal(30), z.literal(60)]),
  srcFps: z.number().positive(),
  frameMode: FrameMode,
  inputQuality: PoseQuality,
  strokes: z.array(PreparedStrokeState).min(1),
  checkpointTable: z.array(CheckpointRow),
  visualToJudge: z.array(VisualToJudge),
  candidates: Candidates,
  /** Sub-scores from measured checkpoints only (V not yet judged). */
  subScoresPreview: z.array(SubScorePreview),
  /** Skill-weighted measured coverage (same formula as the final overall coverage; V items not yet in Σw). */
  coverage: Unit,
  warnings: z.array(PrepareWarning),
  frameRequests: z.array(FrameRequest),
});

/** Zod schema of `analyses.prepared`; consistency checks mirror the prepare.v1 invariants. */
export const PreparedAnalysisV1 = PreparedObject.superRefine((p, ctx) => {
  const ids = new Set(p.strokes.map((s) => s.id));
  if (ids.size !== p.strokes.length) ctx.addIssue({ code: 'custom', path: ['strokes'], message: 'duplicate ids' });
  for (const row of p.checkpointTable) {
    for (const ps of row.perStroke) {
      if (!ids.has(ps.strokeId)) {
        ctx.addIssue({ code: 'custom', path: ['checkpointTable'], message: `${row.id}: unknown stroke` });
      }
    }
    if ((row.status === 'measured') !== (row.s !== null)) {
      ctx.addIssue({ code: 'custom', path: ['checkpointTable'], message: `${row.id}: s is set iff measured` });
    }
  }
  for (const f of p.frameRequests) {
    if (!ids.has(f.strokeId)) ctx.addIssue({ code: 'custom', path: ['frameRequests'], message: 'unknown stroke' });
  }
});
export type PreparedAnalysisV1 = z.infer<typeof PreparedAnalysisV1>;
export const PreparedAnalysisV1Structure = PreparedObject;
