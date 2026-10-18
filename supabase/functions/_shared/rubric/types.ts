/**
 * Rubric data model (DESIGN-v1.0 §6.3 with the DESIGN.md §6.3 v1.1 changes):
 * - no `ruleFlag` (no legality badges in MVP); `injuryFlag` stays and becomes a fixed safety note;
 * - SkillDef gains `contactOffsetMs`, `views {recommended, allowed}`, `solo`, `rulesTip`; `preferredView` is gone;
 * - CheckpointDef gains `plain` evidence templates; V checkpoints carry 5 `vAnchors` (EN, sent to Claude).
 * Whether a skill is offered is decided by the `enabled_skills` DB table, never by the JSON.
 *
 * View codes: S = side, B = behind, D = 45° diagonal, F = front. Checkpoints store factors for S/B/D only; front
 * uses the B factors with lateral signs mirrored (DESIGN.md §6.2 item 10, see `viewFactorColumn` in common.ts).
 */
import type { FactorViewCode, Joint, LocalizedText, Sport, SubScoreKey, ViewCode } from '../contracts/common.ts';
import type { MetricKey } from '../engine/metric_catalog.ts';

export type { FactorViewCode, LocalizedText, ViewCode };

/** M = measured; M~ = measured, rough; V = judged by Claude from frames; N = not assessable from video. */
export const ASSESS_TAGS = ['M', 'M~', 'V', 'N'] as const;
export type Assess = (typeof ASSESS_TAGS)[number];

/** Where a checkpoint is evaluated per stroke; `window` = metric defines its own time window. */
export const CHECKPOINT_PHASES = ['ready', 'bsEnd', 'contact', 'contact+0.2', 'ftStop', 'recovery', 'window'] as const;
export type CheckpointPhase = (typeof CHECKPOINT_PHASES)[number];

export const VIEW_FACTORS = [0, 0.6, 1] as const;
export type ViewFactor = (typeof VIEW_FACTORS)[number];
export type ViewFactors = Record<FactorViewCode, ViewFactor>;

export type MetricParamValue = string | number | boolean;

export interface MetricSpec {
  /** Key in the metric registry (engine/metric_catalog.ts). */
  fn: MetricKey;
  /** Validated against METRIC_CATALOG[fn].params. */
  params?: Record<string, MetricParamValue>;
  /** Numeric band [lo, hi] (null = open side), or the expected boolean / event presence. */
  target: [number | null, number | null] | boolean;
  /** Distance at which the score reaches 0 (s = max(0, 1 − d/tol)). Ignored for booleans. */
  tol: number;
  unit: string;
  /** Optional reference for relative metrics (e.g. "clear" for smash speed vs own clear). */
  relativeTo?: string;
}

export type FiveAnchors = [string, string, string, string, string];

export interface CheckpointDef {
  /** e.g. `bd.clear_fh.C5`; shared ready/split checkpoints: `bd.ready.R2`, `pb.split.S1`. */
  id: string;
  sport: Sport;
  /** Skill ids that evaluate this checkpoint. */
  skills: string[];
  phase: CheckpointPhase;
  subscore: SubScoreKey;
  weight: 1 | 2;
  assess: Assess;
  /** Required for M / M~; absent for V / N. */
  metric?: MetricSpec;
  views: ViewFactors;
  /** Confidence halved at 30 Hz. */
  velocityBased: boolean;
  injuryFlag?: true;
  /**
   * Fixed safety note shown when `injuryFlag` is set (required with it). Ends with "nếu đau, hãy hỏi HLV/chuyên gia"
   * (VI) / "if it hurts, ask a coach or professional" (EN). Advice only, never a diagnosis.
   */
  safety?: LocalizedText;
  /** Required for V: anchors for levels 0..4 (English, sent to Claude in RUBRIC_TEXT). */
  vAnchors?: FiveAnchors;
  name: LocalizedText;
  /** Plain-language evidence templates for a low / high reading, e.g. "khuỷu tay còn gập khi chạm cầu". */
  plain: { vi: { low: string; high: string }; en: { low: string; high: string } };
  faults: string[];
  /** Joints highlighted on the key-frame skeleton. */
  joints: Joint[];
}

export interface FaultDef {
  id: string;
  checkpoint: string;
  /** Which reading triggers the fault: below band, above band, or boolean false. */
  when: 'low' | 'high' | 'false';
  title: LocalizedText;
  /** ≤ 8 words. */
  cue: LocalizedText;
  why: LocalizedText;
  /** Allowed drill ids (≥ 1). */
  drills: string[];
  defaultDrill: string;
}

export interface DrillDose {
  sets: number;
  reps?: number;
  seconds?: number;
}

export interface DrillDef {
  id: string;
  sport: Sport;
  dose: DrillDose;
  title: LocalizedText;
  steps: { vi: string[]; en: string[] };
  safety?: LocalizedText;
}

export type SkillFamily = 'overhead' | 'side' | 'underarm';

export interface SkillDef {
  id: string;
  sport: Sport;
  name: LocalizedText;
  /** Sub-score weights, sum 100. */
  weights: Record<SubScoreKey, number>;
  /** Segmentation: min peak wrist speed (T/s) and NMS spacing (s). */
  vmin: number;
  nms: number;
  family: SkillFamily;
  /** Added to the parabolic speed peak to estimate contact; fitted from coach labels (starts at 0). */
  contactOffsetMs: number;
  views: { recommended: ViewCode[]; allowed: ViewCode[] };
  /** Serves: can be practised alone (picker badge). */
  solo: boolean;
  /** Static rules card shown on results. */
  rulesTip: LocalizedText;
  /** Checkpoint ids evaluated for this skill (own + shared ready/split). */
  checkpoints: string[];
}

/** One sport's rubric JSON file (`badminton.json`, `pickleball.json`). */
export interface SportRubricFile {
  version: string;
  sport: Sport;
  skills: SkillDef[];
  checkpoints: CheckpointDef[];
  faults: FaultDef[];
}

/** `drills.json`: drills for both sports. */
export interface DrillsFile {
  version: string;
  drills: DrillDef[];
}

/** What the engine and Claude modules consume: one sport's rubric with its drills. */
export interface RubricBundle {
  /** Human version from the JSON files, e.g. `bd-2026.10.20+drills-2026.10.20`. */
  version: string;
  sport: Sport;
  skills: SkillDef[];
  checkpoints: CheckpointDef[];
  faults: FaultDef[];
  drills: DrillDef[];
}
