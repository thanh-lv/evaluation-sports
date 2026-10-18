/**
 * Zod mirror of rubric/types.ts, used by load.ts to validate the JSON once per cold start. Structural only;
 * cross-reference integrity (weights sum, drills exist, anchors, …) lives in supabase/tests/rubric.
 */
import { z } from 'zod';
import { FACTOR_VIEW_CODES, Joint, LocalizedText, Sport, SUB_SCORE_KEYS, VIEW_CODES } from '../contracts/common.ts';
import { METRIC_KEYS } from '../engine/metric_catalog.ts';
import { ASSESS_TAGS, CHECKPOINT_PHASES } from './types.ts';
import type { CheckpointDef, DrillDef, DrillsFile, FaultDef, SkillDef, SportRubricFile } from './types.ts';

const ViewFactor = z.union([z.literal(0), z.literal(0.6), z.literal(1)]);
const ViewCode = z.enum(VIEW_CODES);

export const MetricSpecSchema = z.object({
  fn: z.enum(METRIC_KEYS),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  target: z.union([z.tuple([z.number().nullable(), z.number().nullable()]), z.boolean()]),
  tol: z.number().nonnegative(),
  unit: z.string(),
  relativeTo: z.string().optional(),
});

const PlainPair = z.object({ low: z.string(), high: z.string() });

export const CheckpointDefSchema = z.object({
  id: z.string(),
  sport: Sport,
  skills: z.array(z.string()),
  phase: z.enum(CHECKPOINT_PHASES),
  subscore: z.enum(SUB_SCORE_KEYS),
  weight: z.union([z.literal(1), z.literal(2)]),
  assess: z.enum(ASSESS_TAGS),
  metric: MetricSpecSchema.optional(),
  views: z.object(Object.fromEntries(FACTOR_VIEW_CODES.map((v) => [v, ViewFactor])) as Record<
    (typeof FACTOR_VIEW_CODES)[number],
    typeof ViewFactor
  >),
  velocityBased: z.boolean(),
  injuryFlag: z.literal(true).optional(),
  vAnchors: z.tuple([z.string(), z.string(), z.string(), z.string(), z.string()]).optional(),
  name: LocalizedText,
  plain: z.object({ vi: PlainPair, en: PlainPair }),
  faults: z.array(z.string()),
  joints: z.array(Joint),
});

export const FaultDefSchema = z.object({
  id: z.string(),
  checkpoint: z.string(),
  when: z.enum(['low', 'high', 'false']),
  title: LocalizedText,
  cue: LocalizedText,
  why: LocalizedText,
  drills: z.array(z.string()).min(1),
  defaultDrill: z.string(),
});

export const DrillDefSchema = z.object({
  id: z.string(),
  sport: Sport,
  dose: z.object({
    sets: z.number().int().positive(),
    reps: z.number().int().positive().optional(),
    seconds: z.number().int().positive().optional(),
  }),
  title: LocalizedText,
  steps: z.object({ vi: z.array(z.string()), en: z.array(z.string()) }),
  safety: LocalizedText.optional(),
});

export const SkillDefSchema = z.object({
  id: z.string(),
  sport: Sport,
  name: LocalizedText,
  weights: z.object(Object.fromEntries(SUB_SCORE_KEYS.map((k) => [k, z.number().nonnegative()])) as Record<
    (typeof SUB_SCORE_KEYS)[number],
    z.ZodNumber
  >),
  vmin: z.number().positive(),
  nms: z.number().positive(),
  family: z.enum(['overhead', 'side', 'underarm']),
  contactOffsetMs: z.number(),
  views: z.object({ recommended: z.array(ViewCode), allowed: z.array(ViewCode) }),
  solo: z.boolean(),
  rulesTip: LocalizedText,
  checkpoints: z.array(z.string()),
});

export const SportRubricFileSchema = z.object({
  version: z.string(),
  sport: Sport,
  skills: z.array(SkillDefSchema),
  checkpoints: z.array(CheckpointDefSchema),
  faults: z.array(FaultDefSchema),
});

export const DrillsFileSchema = z.object({ version: z.string(), drills: z.array(DrillDefSchema) });

// Compile-time guarantee that the Zod mirror and the hand-written interfaces agree.
type Assert<T extends true> = T;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export type _RubricSchemaChecks = [
  Assert<Same<z.infer<typeof CheckpointDefSchema>, CheckpointDef>>,
  Assert<Same<z.infer<typeof FaultDefSchema>, FaultDef>>,
  Assert<Same<z.infer<typeof DrillDefSchema>, DrillDef>>,
  Assert<Same<z.infer<typeof SkillDefSchema>, SkillDef>>,
  Assert<Same<z.infer<typeof SportRubricFileSchema>, SportRubricFile>>,
  Assert<Same<z.infer<typeof DrillsFileSchema>, DrillsFile>>,
];
