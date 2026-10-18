/**
 * `coach.v1`: Claude's structured output, one JSON Schema per sport (DESIGN.md §7.4, DESIGN-v1.0 §7.3 minus
 * `stroke_notes`). Sent as `output_config.format.schema`.
 *
 * Structured-output rules enforced by construction (and re-checked by `auditCoachOutputSchema`):
 * - every enum lives ONCE in `$defs` and is referenced with `$ref`;
 * - no numeric bounds, string lengths, minItems > 1, patterns or formats; descriptions carry the soft limits;
 * - `additionalProperties: false` and every property required on every object; no recursion.
 *
 * The model output is parsed with the LENIENT `CoachOutputV1` Zod schema below: enum-typed fields are plain strings
 * because capitalisation is not guaranteed; postprocess normalises them case-insensitively against the catalog.
 */
import { z } from 'zod';
import { type Sport, UPLOAD_FRAME_IDS } from './common.ts';
import type { JsonSchema } from './json_schema.ts';
import type { RubricBundle } from '../rubric/types.ts';

export const COACH_SCHEMA_VERSION = 'coach.v1';

export const INPUT_ISSUES = [
  'no_person',
  'wrong_person',
  'subject_cut_off',
  'too_dark',
  'motion_blur',
  'too_far',
  'occlusion',
  'wrong_sport',
  'wrong_skill',
  'camera_angle_limits',
  'other',
] as const;
export const VISIBILITY = ['good', 'partial', 'poor'] as const;
export const CONFIDENCE = ['low', 'medium', 'high'] as const;
export const SEVERITY = ['high', 'medium', 'low'] as const;
export const SAFETY_KINDS = ['warmup', 'load', 'technique_risk', 'see_professional'] as const;
export const NO_FAULT = 'none';

export type InputIssue = (typeof INPUT_ISSUES)[number];
export type Visibility = (typeof VISIBILITY)[number];
export type Confidence = (typeof CONFIDENCE)[number];
export type Severity = (typeof SEVERITY)[number];
export type SafetyKind = (typeof SAFETY_KINDS)[number];

/** The per-sport id lists that parameterise the schema. */
export interface CoachSchemaCatalog {
  sport: Sport;
  /** Every scorable (M, M~, V) checkpoint id of the sport, all skills incl. disabled ones (schema stays stable). */
  checkpointIds: readonly string[];
  /** The V subset. */
  visualCheckpointIds: readonly string[];
  /** Every fault id of the sport; `none` is appended by the builder. */
  faultIds: readonly string[];
}

export function coachSchemaCatalogFromRubric(rubric: RubricBundle): CoachSchemaCatalog {
  const scorable = rubric.checkpoints.filter((c) => c.assess !== 'N');
  return {
    sport: rubric.sport,
    checkpointIds: scorable.map((c) => c.id),
    visualCheckpointIds: scorable.filter((c) => c.assess === 'V').map((c) => c.id),
    faultIds: rubric.faults.map((f) => f.id),
  };
}

const ref = (name: string): JsonSchema => ({ $ref: `#/$defs/${name}` });
const str = (description?: string): JsonSchema => (description ? { type: 'string', description } : { type: 'string' });
const int = (description: string): JsonSchema => ({ type: 'integer', description });
const arrayOf = (items: JsonSchema, description?: string): JsonSchema =>
  description ? { type: 'array', items, description } : { type: 'array', items };
const enumDef = (values: readonly string[], description?: string): JsonSchema => {
  const def: JsonSchema = { type: 'string', enum: [...values] };
  if (description) def.description = description;
  return def;
};
/** Object with additionalProperties:false and every property required. */
const obj = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});

function assertIds(label: string, ids: readonly string[]): void {
  if (ids.length === 0) throw new Error(`coach schema: ${label} must not be empty`);
  if (new Set(ids).size !== ids.length) throw new Error(`coach schema: ${label} has duplicates`);
  if (ids.some((id) => id === '' || id.toLowerCase() === NO_FAULT)) throw new Error(`coach schema: bad id in ${label}`);
}

/** Builds the per-sport Claude output JSON Schema. Deterministic for a given catalog (cache/grammar stability). */
export function buildCoachOutputSchema(catalog: CoachSchemaCatalog): JsonSchema {
  assertIds('checkpointIds', catalog.checkpointIds);
  assertIds('visualCheckpointIds', catalog.visualCheckpointIds);
  assertIds('faultIds', catalog.faultIds);
  const missing = catalog.visualCheckpointIds.filter((id) => !catalog.checkpointIds.includes(id));
  if (missing.length) throw new Error(`coach schema: visual ids not in checkpointIds: ${missing.join(', ')}`);

  const $defs: Record<string, JsonSchema> = {
    SchemaVersion: enumDef([COACH_SCHEMA_VERSION]),
    Language: enumDef(['vi', 'en']),
    CheckpointId: enumDef(catalog.checkpointIds),
    VisualCheckpointId: enumDef(catalog.visualCheckpointIds),
    FaultId: enumDef([...catalog.faultIds, NO_FAULT]),
    Severity: enumDef(SEVERITY),
    Confidence: enumDef(CONFIDENCE),
    Visibility: enumDef(VISIBILITY),
    InputIssue: enumDef(INPUT_ISSUES),
    SafetyKind: enumDef(SAFETY_KINDS),
    // Only uploaded frames (F1..F5) are ever shown to the model; L# frames stay on the device.
    FrameId: enumDef(UPLOAD_FRAME_IDS),
    EmptyString: enumDef([''], 'empty: no value'),
    InputCheck: obj({
      is_assessable: { type: 'boolean' },
      sport_matches: { type: 'boolean' },
      skill_matches: { type: 'boolean' },
      subject_visibility: ref('Visibility'),
      issues: arrayOf(ref('InputIssue')),
      note: str(),
    }),
    VisualJudgment: obj({
      checkpoint_id: ref('VisualCheckpointId'),
      level: int('0-4 per the anchors; -1 = not assessable'),
      confidence: ref('Confidence'),
      frame_ids: arrayOf(ref('FrameId'), 'frames that show it'),
      note: str(),
    }),
    Evidence: obj({
      stroke_id: int('stroke id from <strokes>; -1 = whole clip'),
      frame_id: { anyOf: [ref('FrameId'), ref('EmptyString')], description: 'frame that shows it, or "" if none' },
      metric_key: {
        anyOf: [ref('CheckpointId'), ref('EmptyString')],
        description: 'checkpoint id from <checkpoints>, or "" for a visual-only observation',
      },
      observation: str('plain language, no digits or units'),
    }),
    Strength: obj({
      checkpoint_id: ref('CheckpointId'),
      title: str(),
      detail: str(),
      evidence: arrayOf(ref('Evidence')),
    }),
    Weakness: obj({
      checkpoint_id: ref('CheckpointId'),
      fault_id: ref('FaultId'),
      severity: ref('Severity'),
      title: str(),
      detail: str(),
      why_it_matters: str(),
      evidence: arrayOf(ref('Evidence')),
    }),
    Improvement: obj({
      priority: int('1 = most important'),
      fault_id: ref('FaultId'),
      title: str(),
      how_to_fix: str(),
      cues: arrayOf(str(), 'each at most eight words'),
      drill_ids: arrayOf(str(), 'one or two ids from the fault allowed drills'),
      goal: str(),
    }),
    SafetyNote: obj({ kind: ref('SafetyKind'), message: str() }),
    NotAssessable: obj({ aspect: str(), how_to_capture: str() }),
  };

  return {
    ...obj({
      schema_version: ref('SchemaVersion'),
      language: ref('Language'),
      input_check: ref('InputCheck'),
      visual_checkpoints: arrayOf(ref('VisualJudgment')),
      summary: str('two or three encouraging sentences'),
      strengths: arrayOf(ref('Strength'), 'one to three'),
      weaknesses: arrayOf(ref('Weakness'), 'one to three, most impactful first'),
      improvements: arrayOf(ref('Improvement'), 'one per weakness'),
      safety_notes: arrayOf(ref('SafetyNote')),
      not_assessable: arrayOf(ref('NotAssessable')),
      recording_tips: arrayOf(str()),
    }),
    $defs,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Lenient parser for the model's output. Unknown keys are stripped; enum fields are free strings.

export const CoachEvidenceOut = z.object({
  stroke_id: z.number(),
  frame_id: z.string(),
  metric_key: z.string(),
  observation: z.string(),
});

export const CoachOutputV1 = z.object({
  schema_version: z.string(),
  language: z.string(),
  input_check: z.object({
    is_assessable: z.boolean(),
    sport_matches: z.boolean(),
    skill_matches: z.boolean(),
    subject_visibility: z.string(),
    issues: z.array(z.string()),
    note: z.string(),
  }),
  visual_checkpoints: z.array(
    z.object({
      checkpoint_id: z.string(),
      level: z.number(),
      confidence: z.string(),
      frame_ids: z.array(z.string()),
      note: z.string(),
    }),
  ),
  summary: z.string(),
  strengths: z.array(
    z.object({
      checkpoint_id: z.string(),
      title: z.string(),
      detail: z.string(),
      evidence: z.array(CoachEvidenceOut),
    }),
  ),
  weaknesses: z.array(
    z.object({
      checkpoint_id: z.string(),
      fault_id: z.string(),
      severity: z.string(),
      title: z.string(),
      detail: z.string(),
      why_it_matters: z.string(),
      evidence: z.array(CoachEvidenceOut),
    }),
  ),
  improvements: z.array(
    z.object({
      priority: z.number(),
      fault_id: z.string(),
      title: z.string(),
      how_to_fix: z.string(),
      cues: z.array(z.string()),
      drill_ids: z.array(z.string()),
      goal: z.string(),
    }),
  ),
  safety_notes: z.array(z.object({ kind: z.string(), message: z.string() })),
  not_assessable: z.array(z.object({ aspect: z.string(), how_to_capture: z.string() })),
  recording_tips: z.array(z.string()),
});
export type CoachOutputV1 = z.infer<typeof CoachOutputV1>;
export type CoachEvidenceOut = z.infer<typeof CoachEvidenceOut>;
