/**
 * `coach-result.v1`: the stored, rendered result (DESIGN.md §7.5). Stored full in `analysis_results.result`;
 * clients receive it only through `rpc get_result(id)`, redacted by tier (`access`).
 *
 * Semantics fixed here (DESIGN leaves them open):
 * - `hero` is the first surviving weakness; `weaknesses` lists the OTHER weaknesses (hero excluded).
 * - `plan` is ordered by priority; priority 1 addresses the hero.
 * - Free redaction (`access: "free"`): hero, overall, subScores, at most 1 strength; `weaknesses` and `plan` are
 *   empty, `checkpoints` is absent and `locked` holds the hidden counts. Full: `locked` is all zeros.
 * - Catalog-sourced text is `{vi, en}` and follows the UI language; model text is in `narrativeLanguage`.
 * - Scores are display values rounded to 5 (`round(x/5)·5`); exact values never leave the server.
 */
import { z } from 'zod';
import {
  AnalysisKind,
  FrameId,
  Joint,
  Language,
  Level,
  LocalizedText,
  LowerUuid,
  MicroSeconds,
  RESULT_REJECTION_CODES,
  SkillId,
  Sport,
  SUB_SCORE_KEYS,
  SubScoreKey,
  TipKeySchema,
} from './common.ts';
import { CONFIDENCE, SAFETY_KINDS, SEVERITY } from './coach_output.ts';
import { StrokePhasesUs, StrokeRole } from './prepare_v1.ts';

const DisplayScore = z
  .number()
  .int()
  .min(0)
  .max(100)
  .refine((v) => v % 5 === 0, 'display scores are multiples of 5');
const Unit = z.number().min(0).max(1);
export const ResultConfidence = z.enum(CONFIDENCE);
export const ResultSeverity = z.enum(SEVERITY);
export const ResultSafetyKind = z.enum(SAFETY_KINDS);

export const ResultEvidence = z.object({
  /** -1 = whole clip. */
  strokeId: z.number().int(),
  /** Phase time of the referenced stroke (snapped), null for whole-clip evidence. */
  tUs: MicroSeconds.nullable(),
  /** F# for the best stroke, L# for the worst; null when no frame applies. */
  frameId: FrameId.nullable(),
  /** Checkpoint id; null for a visual-only observation. */
  metricKey: z.string().nullable(),
  /** Model text in narrativeLanguage, digit-free. */
  observation: z.string(),
  /** Catalog plain-language template (CheckpointDef.plain, low/high chosen by the server). */
  plain: LocalizedText.nullable(),
  /** Measured value and target as display text, shown under "Chi tiết". */
  detail: z.object({ valueText: z.string(), targetText: z.string() }).nullable(),
  joints: z.array(Joint),
}).meta({ id: 'ResultEvidence' });
export type ResultEvidence = z.infer<typeof ResultEvidence>;

export const ResultDrill = z.object({
  id: z.string(),
  title: LocalizedText,
  steps: z.object({ vi: z.array(z.string()), en: z.array(z.string()) }),
  dose: z.object({
    sets: z.number().int().positive(),
    reps: z.number().int().positive().nullable(),
    seconds: z.number().int().positive().nullable(),
  }),
  safety: LocalizedText.nullable(),
}).meta({ id: 'ResultDrill' });
export type ResultDrill = z.infer<typeof ResultDrill>;

export const ResultHero = z.object({
  checkpointId: z.string(),
  /** null when the weakness came from a visual checkpoint without a catalog fault. */
  faultId: z.string().nullable(),
  title: z.string(),
  observation: z.string(),
  cue: LocalizedText,
  drill: ResultDrill.nullable(),
  frameId: FrameId.nullable(),
  joints: z.array(Joint),
}).meta({ id: 'ResultHero' });
export type ResultHero = z.infer<typeof ResultHero>;

export const ResultOverall = z.object({
  /** null when partial (coverage < 0.5). */
  displayScore: DisplayScore.nullable(),
  level: Level.nullable(),
  coverage: Unit,
  partial: z.boolean(),
  beta: z.literal(true),
}).meta({ id: 'ResultOverall' });
export type ResultOverall = z.infer<typeof ResultOverall>;

export const ResultSubScore = z.object({
  key: SubScoreKey,
  /** null = "Chưa đủ dữ liệu" (coverage < 0.4). */
  displayScore: DisplayScore.nullable(),
  coverage: Unit,
  confidence: ResultConfidence,
  name: LocalizedText,
}).meta({ id: 'ResultSubScore' });
export type ResultSubScore = z.infer<typeof ResultSubScore>;

export const ResultCheckpoint = z.object({
  id: z.string(),
  subscore: SubScoreKey,
  assess: z.enum(['M', 'M~', 'V', 'N']),
  /** Score 0..1 and confidence 0..1; s null when not assessed. */
  s: Unit.nullable(),
  c: Unit,
  valueText: z.string(),
  targetText: z.string(),
  perStroke: z.array(z.object({ strokeId: z.number().int(), value: z.number().nullable() })),
  name: LocalizedText,
  joints: z.array(Joint),
}).meta({ id: 'ResultCheckpoint' });
export type ResultCheckpoint = z.infer<typeof ResultCheckpoint>;

export const ResultStrength = z.object({
  checkpointId: z.string(),
  title: z.string(),
  detail: z.string(),
  evidence: z.array(ResultEvidence),
}).meta({ id: 'ResultStrength' });
export type ResultStrength = z.infer<typeof ResultStrength>;

export const ResultWeakness = z.object({
  checkpointId: z.string(),
  faultId: z.string().nullable(),
  severity: ResultSeverity,
  title: z.string(),
  detail: z.string(),
  whyItMatters: z.string(),
  cue: LocalizedText,
  evidence: z.array(ResultEvidence),
}).meta({ id: 'ResultWeakness' });
export type ResultWeakness = z.infer<typeof ResultWeakness>;

export const ResultPlanItem = z.object({
  priority: z.number().int().positive(),
  faultId: z.string().nullable(),
  title: z.string(),
  howToFix: z.string(),
  cues: z.array(z.string()),
  goal: z.string(),
  /**
   * Measured value vs goal for the fault's checkpoint (DESIGN-v1.0 §7.4 names), both as server-formatted display
   * text like Evidence.detail; null for visual items.
   */
  target: z.object({ metricKey: z.string(), current: z.string(), goal: z.string() }).nullable(),
  drills: z.array(ResultDrill),
}).meta({ id: 'ResultPlanItem' });
export type ResultPlanItem = z.infer<typeof ResultPlanItem>;

export const ResultStroke = z.object({
  id: z.number().int().positive(),
  tStartUs: MicroSeconds,
  tContactUs: MicroSeconds,
  contactIsEstimate: z.boolean(),
  tEndUs: MicroSeconds,
  phases: StrokePhasesUs,
  role: StrokeRole,
}).meta({ id: 'ResultStroke' });
export type ResultStroke = z.infer<typeof ResultStroke>;

export const ResultSafetyNote = z.object({
  kind: ResultSafetyKind,
  /** In narrativeLanguage (model text, or catalog text in that language). */
  message: z.string(),
  /** Set for fixed injury-flag notes from the rubric (follows the UI language). */
  localized: LocalizedText.nullable(),
  checkpointId: z.string().nullable(),
}).meta({ id: 'ResultSafetyNote' });
export type ResultSafetyNote = z.infer<typeof ResultSafetyNote>;

export const ResultMeta = z.object({
  model: z.string(),
  kind: AnalysisKind,
  promptVersion: z.string(),
  rubricVersion: z.string(),
  algoVersion: z.string(),
  schemaVersion: z.string(),
}).meta({ id: 'ResultMeta' });
export type ResultMeta = z.infer<typeof ResultMeta>;

const CoachResultObject = z.object({
  schema: z.literal('coach-result.v1'),
  analysisId: LowerUuid,
  sport: Sport,
  skill: SkillId,
  narrativeLanguage: Language,
  /** ISO 8601 UTC. */
  createdAt: z.string(),
  status: z.enum(['succeeded', 'rejected']),
  /** Postprocess input-check rejection (RESULT_REJECTION_CODES); tips are TIP_KEYS. */
  rejection: z.object({ code: z.enum(RESULT_REJECTION_CODES), tips: z.array(TipKeySchema) }).nullable(),
  access: z.enum(['full', 'free']),
  locked: z.object({
    strengths: z.number().int().nonnegative(),
    weaknesses: z.number().int().nonnegative(),
    plan: z.number().int().nonnegative(),
  }),
  aiGenerated: z.literal(true),
  hero: ResultHero.nullable(),
  overall: ResultOverall,
  subScores: z.array(ResultSubScore),
  checkpoints: z.array(ResultCheckpoint).optional(),
  strengths: z.array(ResultStrength),
  weaknesses: z.array(ResultWeakness),
  plan: z.array(ResultPlanItem),
  strokes: z.array(ResultStroke),
  safety: z.array(ResultSafetyNote),
  notAssessable: z.array(z.object({ aspect: z.string(), howToCapture: z.string() })),
  recordingTips: z.array(z.string()),
  rulesTip: LocalizedText,
  summary: z.string(),
  meta: ResultMeta,
});

export const CoachResultV1 = CoachResultObject.superRefine((r, ctx) => {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  if ((r.status === 'rejected') !== (r.rejection !== null)) {
    issue(['rejection'], 'rejection is set iff status=rejected');
  }
  if (r.status === 'rejected' && r.hero !== null) issue(['hero'], 'rejected results have no hero');
  if (r.overall.partial && r.overall.displayScore !== null) issue(['overall'], 'partial results have no score');
  if ((r.overall.displayScore === null) !== (r.overall.level === null)) {
    issue(['overall', 'level'], 'level is set iff displayScore is set');
  }
  if (r.status === 'succeeded') {
    const keys = r.subScores.map((s) => s.key);
    if (keys.length !== SUB_SCORE_KEYS.length || keys.some((k, i) => k !== SUB_SCORE_KEYS[i])) {
      issue(['subScores'], `subScores must list ${SUB_SCORE_KEYS.join(',')} in order`);
    }
  }
  if (r.access === 'free') {
    if (r.checkpoints !== undefined) issue(['checkpoints'], 'free access has no checkpoints');
    if (r.strengths.length > 1) issue(['strengths'], 'free access shows at most 1 strength');
    if (r.weaknesses.length > 0 || r.plan.length > 0) issue(['weaknesses'], 'free access hides weaknesses and plan');
  } else if (r.locked.strengths + r.locked.weaknesses + r.locked.plan !== 0) {
    issue(['locked'], 'full access has nothing locked');
  }
  const priorities = r.plan.map((p) => p.priority);
  if (priorities.some((p, i) => p !== i + 1)) issue(['plan'], 'plan priorities must be 1..n in order');
  if (r.plan.length > 3) issue(['plan'], 'at most 3 plan items');
});
export type CoachResultV1 = z.infer<typeof CoachResultV1>;
export const CoachResultV1Structure = CoachResultObject;
