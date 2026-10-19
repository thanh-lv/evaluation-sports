/**
 * Post-processing of Claude's coach.v1 output (DESIGN.md §8.4 steps 1–8; step 9, compose, is compose.ts). Pure:
 * every decision is returned as data plus `flags` for the caller to log.
 *
 * 1. input check → rejected (skipped when no frames were sent: the model cannot see the video then)
 * 2. case-insensitive enum normalisation; unknown values are dropped
 * 3. visual checkpoints: this skill's V ids, level clamped to −1..4, unsent frames dropped, pose_only → −1
 * 4. grounding: findings from <candidates> or confident visual judgments only; evidence must cite a table metric
 *    and/or a sent frame and a valid stroke; observations lose digits/units (< 3 words → catalog plain template)
 * 5. deterministic override of the top weakness candidate
 * 6. hero = first weakness (frame chosen in compose)
 * 7. ≤ 3 improvements, one per weakness in weakness order, drills validated against the fault
 * 8. medical filter on all model prose
 */
import {
  CONFIDENCE,
  type Confidence,
  INPUT_ISSUES,
  type Language,
  type LocalizedText,
  NO_FAULT,
  REJECTION_TIPS,
  type ResultRejectionCode,
  SAFETY_KINDS,
  type SafetyKind,
  SEVERITY,
  type Severity,
  type TipKey,
  UPLOAD_FRAME_IDS,
  type UploadFrameId,
  VISIBILITY,
  type Visibility,
} from '../contracts/index.ts';
import type { CoachEvidenceOut, CoachOutputV1 } from '../contracts/coach_output.ts';
import type { PreparedAnalysisV1, StrengthCandidate, WeaknessCandidate } from '../engine/prepared_state.ts';
import type { VisualJudgmentInput } from '../engine/score.ts';
import type { CheckpointDef, FaultDef, RubricBundle } from '../rubric/types.ts';
import { GENERIC_SUMMARY, GENERIC_WHY, REJECTED_SUMMARY, SEE_PROFESSIONAL_NOTE } from './copy.ts';
import { EnumMatcher } from './enum_norm.ts';
import { findMedicalTerm } from './medical_filter.ts';
import { hasDigits, sentence, stripNumbers, wordCount } from './text_clean.ts';

export const POSTPROCESS_LIMITS = {
  strengths: 3,
  weaknesses: 3,
  improvements: 3,
  evidencePerFinding: 3,
  drillsPerImprovement: 2,
  cues: 3,
  notes: 3,
  minObservationWords: 3,
  overrideMinC: 0.6,
  overrideImpactRatio: 1.5,
} as const;

export interface PostprocessContext {
  prepared: PreparedAnalysisV1;
  rubric: RubricBundle;
  /** Narrative language (`analyses.language`), whatever the model claims. */
  language: Language;
  /** Frames attached to the request (BuiltCoachRequest.sentFrameIds). */
  sentFrameIds: readonly UploadFrameId[];
}

export type PostFlagType =
  | 'enum_dropped'
  | 'language_mismatch'
  | 'input_check_ignored'
  | 'visual_dropped'
  | 'finding_dropped'
  | 'evidence_dropped'
  | 'evidence_added'
  | 'observation_stripped'
  | 'observation_replaced'
  | 'override'
  | 'improvement_added'
  | 'drill_replaced'
  | 'flag_medical';

export interface PostFlag {
  type: PostFlagType;
  detail: string;
}

export interface PEvidence {
  /** −1 = whole clip. */
  strokeId: number;
  /** A frame that was sent, or null. */
  frameId: UploadFrameId | null;
  /** A checkpoint id of this analysis' table, or null. */
  metricKey: string | null;
  observation: string;
}

export interface PVisual {
  checkpointId: string;
  level: number;
  confidence: Confidence;
  frameIds: UploadFrameId[];
  note: string;
}

export type FindingSource = 'candidate' | 'visual' | 'override';

export interface PStrength {
  checkpointId: string;
  source: FindingSource;
  title: string;
  detail: string;
  evidence: PEvidence[];
}

export interface PWeakness {
  checkpointId: string;
  faultId: string | null;
  source: FindingSource;
  severity: Severity;
  title: string;
  detail: string;
  whyItMatters: string;
  evidence: PEvidence[];
}

/** One per weakness, same order (priority = index + 1). */
export interface PImprovement {
  checkpointId: string;
  faultId: string | null;
  title: string;
  howToFix: string;
  cues: string[];
  drillIds: string[];
  goal: string;
}

export interface PInputCheck {
  isAssessable: boolean;
  sportMatches: boolean;
  skillMatches: boolean;
  visibility: Visibility;
  issues: string[];
}

interface Common {
  inputCheck: PInputCheck;
  summary: string;
  recordingTips: string[];
  flags: PostFlag[];
}

export interface PostprocessRejected extends Common {
  status: 'rejected';
  rejection: { code: ResultRejectionCode; tips: TipKey[] };
}

export interface PostprocessOk extends Common {
  status: 'ok';
  visual: PVisual[];
  /** Input for composeScores. */
  visualJudgments: VisualJudgmentInput[];
  strengths: PStrength[];
  weaknesses: PWeakness[];
  improvements: PImprovement[];
  safetyNotes: { kind: SafetyKind; message: string }[];
  notAssessable: { aspect: string; howToCapture: string }[];
  /** True when the medical filter replaced something: compose adds the generic see_professional note. */
  medicalHit: boolean;
}

export type PostprocessResult = PostprocessOk | PostprocessRejected;

const CONFIDENCE_RANK: Readonly<Record<Confidence, number>> = { low: 0, medium: 1, high: 2 };
const confident = (c: Confidence) => CONFIDENCE_RANK[c] >= CONFIDENCE_RANK.medium;

/** Everything the steps share. */
class Ctx {
  readonly flags: PostFlag[] = [];
  medicalHit = false;
  readonly lang: Language;
  readonly sent: ReadonlySet<UploadFrameId>;
  readonly noFrames: boolean;
  readonly checkpointIds: EnumMatcher<string>;
  readonly faultIds: EnumMatcher<string>;
  readonly drillIds: EnumMatcher<string>;
  readonly frameIds = new EnumMatcher<UploadFrameId>(UPLOAD_FRAME_IDS);
  readonly defs: Map<string, CheckpointDef>;
  readonly faults: Map<string, FaultDef>;
  readonly tableIds: Set<string>;
  readonly activeStrokes: Set<number>;
  readonly weakCands: Map<string, WeaknessCandidate>;
  readonly strongCands: Map<string, StrengthCandidate>;
  readonly visualIds: Set<string>;

  constructor(readonly c: PostprocessContext) {
    const { prepared: p, rubric } = c;
    this.lang = c.language;
    this.sent = new Set(c.sentFrameIds);
    this.noFrames = p.frameMode === 'pose_only' || this.sent.size === 0;
    this.checkpointIds = new EnumMatcher(rubric.checkpoints.map((x) => x.id));
    this.faultIds = new EnumMatcher(rubric.faults.map((f) => f.id));
    this.drillIds = new EnumMatcher(rubric.drills.map((d) => d.id));
    this.defs = new Map(rubric.checkpoints.map((x) => [x.id, x]));
    this.faults = new Map(rubric.faults.map((f) => [f.id, f]));
    this.tableIds = new Set(p.checkpointTable.map((r) => r.id));
    this.activeStrokes = new Set(p.strokes.filter((s) => !s.excluded).map((s) => s.id));
    this.weakCands = new Map(p.candidates.weaknesses.map((w) => [w.checkpointId, w]));
    this.strongCands = new Map(p.candidates.strengths.map((s) => [s.checkpointId, s]));
    this.visualIds = new Set(p.visualToJudge.map((v) => v.checkpointId));
  }

  flag(type: PostFlagType, detail: string): void {
    // details can echo model strings (enum values, language); flags are logged, so keep them short
    this.flags.push({ type, detail: detail.length > 120 ? `${detail.slice(0, 120)}…` : detail });
  }

  t(text: LocalizedText): string {
    return text[this.lang];
  }

  /** Medical filter (step 8): returns the text, or `fallback` (null = drop) after a hit. */
  clean(text: string, field: string, fallback: string | null): string | null {
    const term = findMedicalTerm(text);
    if (!term) return text;
    this.medicalHit = true;
    this.flag('flag_medical', `${field}: ${term}`);
    return fallback;
  }

  /** Non-empty cleaned text or the fallback. */
  prose(text: string, field: string, fallback: string): string {
    const t = text.trim();
    if (!t) return fallback;
    return this.clean(t, field, fallback) ?? fallback;
  }

  /** Catalog template for a checkpoint side, as a sentence in the narrative language. */
  plain(checkpointId: string, side: 'low' | 'high' | 'ok'): string {
    const def = this.defs.get(checkpointId);
    return def ? sentence(def.plain[this.lang][side]) : '';
  }
}

// ---------------------------------------------------------------------------------------------------------------

function inputCheckOf(o: CoachOutputV1, x: Ctx): PInputCheck {
  const vis = new EnumMatcher(VISIBILITY).match(o.input_check.subject_visibility);
  if (!vis) x.flag('enum_dropped', `input_check.subject_visibility=${o.input_check.subject_visibility}`);
  const issues = new EnumMatcher(INPUT_ISSUES);
  return {
    isAssessable: o.input_check.is_assessable,
    sportMatches: o.input_check.sport_matches,
    skillMatches: o.input_check.skill_matches,
    visibility: vis ?? 'partial',
    issues: [...new Set(o.input_check.issues.map((i) => issues.match(i)).filter((i) => i !== null))] as string[],
  };
}

function rejectionOf(ic: PInputCheck): ResultRejectionCode | null {
  if (!ic.isAssessable) return 'not_assessable';
  if (!ic.sportMatches) return 'wrong_sport';
  if (!ic.skillMatches && ic.visibility === 'poor') return 'wrong_skill';
  return null;
}

function visualStep(o: CoachOutputV1, x: Ctx): PVisual[] {
  const conf = new EnumMatcher(CONFIDENCE);
  const out: PVisual[] = [];
  for (const v of o.visual_checkpoints) {
    const id = x.checkpointIds.match(v.checkpoint_id);
    if (!id || !x.visualIds.has(id)) {
      x.flag('visual_dropped', String(v.checkpoint_id));
      continue;
    }
    if (out.some((e) => e.checkpointId === id)) continue;
    const confidence = conf.match(v.confidence) ?? 'low';
    let level = Number.isFinite(v.level) ? Math.max(-1, Math.min(4, Math.round(v.level))) : -1;
    if (x.noFrames) level = -1;
    const frameIds = [
      ...new Set(v.frame_ids.map((f) => x.frameIds.match(f)).filter((f): f is UploadFrameId => !!f && x.sent.has(f))),
    ];
    const note = x.clean(v.note.trim(), `visual.${id}.note`, '') ?? '';
    out.push({ checkpointId: id, level, confidence, frameIds, note });
  }
  return out;
}

/** Evidence of one finding (step 4); never empty: a catalog item is added when nothing survives. */
function evidenceStep(
  list: readonly CoachEvidenceOut[],
  checkpointId: string,
  fallbackObservation: string,
  fallbackFrame: UploadFrameId | null,
  x: Ctx,
): PEvidence[] {
  const out: PEvidence[] = [];
  for (const e of list) {
    if (out.length >= POSTPROCESS_LIMITS.evidencePerFinding) break;
    const sid = Number.isInteger(e.stroke_id) && (e.stroke_id === -1 || x.activeStrokes.has(e.stroke_id))
      ? e.stroke_id
      : null;
    const fid = e.frame_id.trim() === '' ? null : x.frameIds.match(e.frame_id);
    const frameId = fid && x.sent.has(fid) ? fid : null;
    const mk = e.metric_key.trim() === '' ? null : x.checkpointIds.match(e.metric_key);
    const metricKey = mk && x.tableIds.has(mk) ? mk : null;
    if (sid === null || (!frameId && !metricKey)) {
      x.flag(
        'evidence_dropped',
        `${checkpointId}: stroke ${e.stroke_id} frame "${e.frame_id}" metric "${e.metric_key}"`,
      );
      continue;
    }
    let observation = x.clean(e.observation, `evidence.${checkpointId}`, fallbackObservation) ?? fallbackObservation;
    if (hasDigits(observation)) {
      observation = stripNumbers(observation);
      x.flag('observation_stripped', checkpointId);
    }
    if (wordCount(observation) < POSTPROCESS_LIMITS.minObservationWords && observation !== fallbackObservation) {
      observation = fallbackObservation;
      x.flag('observation_replaced', checkpointId);
    }
    out.push({ strokeId: sid, frameId, metricKey, observation });
  }
  if (!out.length) {
    const measured = x.c.prepared.checkpointTable.find((r) => r.id === checkpointId)?.status === 'measured';
    out.push({
      strokeId: x.c.prepared.strokes.find((s) => s.role === 'best' && !s.excluded)?.id ?? -1,
      frameId: measured ? null : fallbackFrame,
      metricKey: measured || !fallbackFrame ? checkpointId : null,
      observation: fallbackObservation,
    });
    x.flag('evidence_added', checkpointId);
  }
  return out;
}

function visualFrame(checkpointId: string, x: Ctx): UploadFrameId | null {
  const v = x.c.prepared.visualToJudge.find((e) => e.checkpointId === checkpointId);
  return v?.frameIds.find((f) => x.sent.has(f)) ?? null;
}

/** Fault of a visual weakness: the rubric fault for the failing side. */
function visualFault(checkpointId: string, x: Ctx): string | null {
  return x.c.rubric.faults.find((f) => f.checkpoint === checkpointId && (f.when === 'low' || f.when === 'false'))
    ?.id ?? null;
}

function strengthsStep(o: CoachOutputV1, visual: PVisual[], x: Ctx): PStrength[] {
  const out: PStrength[] = [];
  for (const s of o.strengths) {
    const id = x.checkpointIds.match(s.checkpoint_id);
    if (!id) {
      x.flag('enum_dropped', `strengths.checkpoint_id=${s.checkpoint_id}`);
      continue;
    }
    const v = visual.find((e) => e.checkpointId === id);
    const source: FindingSource | null = x.strongCands.has(id)
      ? 'candidate'
      : v && v.level >= 3 && confident(v.confidence)
      ? 'visual'
      : null;
    if (!source || out.some((e) => e.checkpointId === id)) {
      x.flag('finding_dropped', `strength ${id}`);
      continue;
    }
    const def = x.defs.get(id)!;
    const plain = x.plain(id, 'ok');
    out.push({
      checkpointId: id,
      source,
      title: x.prose(s.title, `strength.${id}.title`, x.t(def.name)),
      detail: x.prose(s.detail, `strength.${id}.detail`, plain),
      evidence: evidenceStep(s.evidence, id, plain, visualFrame(id, x), x),
    });
  }
  return out;
}

function weaknessPlain(id: string, x: Ctx): string {
  const cand = x.weakCands.get(id);
  return cand ? sentence(x.t(cand.plain)) : x.plain(id, 'low');
}

function weaknessesStep(o: CoachOutputV1, visual: PVisual[], x: Ctx): PWeakness[] {
  const sev = new EnumMatcher(SEVERITY);
  const out: PWeakness[] = [];
  for (const w of o.weaknesses) {
    const id = x.checkpointIds.match(w.checkpoint_id);
    if (!id) {
      x.flag('enum_dropped', `weaknesses.checkpoint_id=${w.checkpoint_id}`);
      continue;
    }
    const cand = x.weakCands.get(id);
    const v = visual.find((e) => e.checkpointId === id);
    const source: FindingSource | null = cand
      ? 'candidate'
      : v && v.level >= 0 && v.level <= 1 && confident(v.confidence)
      ? 'visual'
      : null;
    if (!source || out.some((e) => e.checkpointId === id)) {
      x.flag('finding_dropped', `weakness ${id}`);
      continue;
    }
    const expected = cand ? cand.faultId : visualFault(id, x);
    const given = w.fault_id.trim().toLowerCase() === NO_FAULT ? null : x.faultIds.match(w.fault_id);
    const faultId = given && x.faults.get(given)?.checkpoint === id ? given : expected;
    const fault = faultId ? x.faults.get(faultId) : undefined;
    const def = x.defs.get(id)!;
    const plain = weaknessPlain(id, x);
    const severity = sev.match(w.severity);
    if (!severity) x.flag('enum_dropped', `weaknesses.severity=${w.severity}`);
    out.push({
      checkpointId: id,
      faultId,
      source,
      severity: severity ?? (out.length === 0 ? 'high' : 'medium'),
      title: x.prose(w.title, `weakness.${id}.title`, x.t(fault?.title ?? def.name)),
      detail: x.prose(w.detail, `weakness.${id}.detail`, plain),
      whyItMatters: x.prose(w.why_it_matters, `weakness.${id}.why`, x.t(fault?.why ?? GENERIC_WHY)),
      evidence: evidenceStep(w.evidence, id, plain, visualFrame(id, x), x),
    });
  }
  return out;
}

/** Step 5: the top candidate is inserted when it clearly dominates and Claude omitted it. */
function overrideStep(weaknesses: PWeakness[], x: Ctx): PWeakness[] {
  const [w1, w2] = x.c.prepared.candidates.weaknesses;
  const L = POSTPROCESS_LIMITS;
  if (!w1 || w1.c < L.overrideMinC) return weaknesses;
  if (w2 && w1.impact < L.overrideImpactRatio * w2.impact) return weaknesses;
  if (weaknesses.some((w) => w.checkpointId === w1.checkpointId)) return weaknesses;
  const fault = w1.faultId ? x.faults.get(w1.faultId) : undefined;
  const def = x.defs.get(w1.checkpointId)!;
  const plain = sentence(x.t(w1.plain));
  x.flag('override', `${w1.checkpointId} ${w1.faultId ?? NO_FAULT}`);
  return [
    {
      checkpointId: w1.checkpointId,
      faultId: w1.faultId,
      source: 'override',
      severity: 'high',
      title: x.t(fault?.title ?? def.name),
      detail: plain,
      whyItMatters: x.t(fault?.why ?? GENERIC_WHY),
      evidence: evidenceStep([], w1.checkpointId, plain, null, x),
    },
    ...weaknesses,
  ];
}

function drillsFor(fault: FaultDef | undefined, given: readonly string[], x: Ctx): string[] {
  if (!fault) return [];
  const ids = [...new Set(given.map((d) => x.drillIds.match(d)).filter((d): d is string => !!d))]
    .filter((d) => fault.drills.includes(d))
    .slice(0, POSTPROCESS_LIMITS.drillsPerImprovement);
  if (ids.length) return ids;
  if (given.length) x.flag('drill_replaced', `${fault.id}: ${given.join(',')} → ${fault.defaultDrill}`);
  return [fault.defaultDrill];
}

function improvementsStep(o: CoachOutputV1, weaknesses: PWeakness[], x: Ctx): PImprovement[] {
  const items = [...o.improvements].sort((a, b) => a.priority - b.priority).map((m) => {
    const raw = m.fault_id.trim().toLowerCase() === NO_FAULT ? null : x.faultIds.match(m.fault_id);
    return { m, faultId: raw, used: false };
  });
  return weaknesses.slice(0, POSTPROCESS_LIMITS.improvements).map((w, i) => {
    const fault = w.faultId ? x.faults.get(w.faultId) : undefined;
    let hit = w.faultId ? items.find((it) => !it.used && it.faultId === w.faultId) : undefined;
    // A weakness without a fault pairs with the improvement written at its position, if that one has no fault.
    if (!hit && !w.faultId && items[i] && !items[i].used && items[i].faultId === null) hit = items[i];
    const cueFallback = fault ? x.t(fault.cue) : x.plain(w.checkpointId, 'ok');
    const goalFallback = x.plain(w.checkpointId, 'ok');
    if (!hit) {
      x.flag('improvement_added', `${w.checkpointId} ${w.faultId ?? NO_FAULT}`);
      return {
        checkpointId: w.checkpointId,
        faultId: w.faultId,
        title: x.t(fault?.title ?? x.defs.get(w.checkpointId)!.name),
        howToFix: cueFallback,
        cues: [cueFallback],
        drillIds: drillsFor(fault, [], x),
        goal: goalFallback,
      };
    }
    hit.used = true;
    const m = hit.m;
    const cues = m.cues
      .map((c) => c.trim())
      .filter((c) => c && x.clean(c, `improvement.${w.checkpointId}.cue`, null) !== null)
      .slice(0, POSTPROCESS_LIMITS.cues);
    return {
      checkpointId: w.checkpointId,
      faultId: w.faultId,
      title: x.prose(m.title, `improvement.${w.checkpointId}.title`, w.title),
      howToFix: x.prose(m.how_to_fix, `improvement.${w.checkpointId}.how`, cueFallback),
      cues: cues.length ? cues : [cueFallback],
      drillIds: drillsFor(fault, m.drill_ids, x),
      goal: x.prose(m.goal, `improvement.${w.checkpointId}.goal`, goalFallback),
    };
  });
}

function notesStep(o: CoachOutputV1, x: Ctx) {
  const kinds = new EnumMatcher(SAFETY_KINDS);
  const safetyNotes: { kind: SafetyKind; message: string }[] = [];
  for (const n of o.safety_notes) {
    const kind = kinds.match(n.kind);
    const message = x.clean(n.message.trim(), 'safety_notes', null);
    if (!kind || !message || safetyNotes.some((s) => s.message === message)) continue;
    if (safetyNotes.length < POSTPROCESS_LIMITS.notes) safetyNotes.push({ kind, message });
  }
  const notAssessable: { aspect: string; howToCapture: string }[] = [];
  for (const n of o.not_assessable) {
    const aspect = x.clean(n.aspect.trim(), 'not_assessable', null);
    const how = x.clean(n.how_to_capture.trim(), 'not_assessable', null);
    if (!aspect || !how || notAssessable.length >= POSTPROCESS_LIMITS.notes) continue;
    notAssessable.push({ aspect, howToCapture: how });
  }
  return { safetyNotes, notAssessable };
}

function recordingTips(o: CoachOutputV1, x: Ctx): string[] {
  const out: string[] = [];
  for (const t of o.recording_tips) {
    const tip = x.clean(t.trim(), 'recording_tips', null);
    if (tip && !out.includes(tip) && out.length < POSTPROCESS_LIMITS.notes) out.push(tip);
  }
  return out;
}

export function postprocess(output: CoachOutputV1, ctx: PostprocessContext): PostprocessResult {
  const x = new Ctx(ctx);
  if (output.language.trim().toLowerCase() !== ctx.language) x.flag('language_mismatch', output.language);
  const inputCheck = inputCheckOf(output, x);
  const code = rejectionOf(inputCheck);
  if (code && x.noFrames) x.flag('input_check_ignored', code);
  else if (code) {
    const note = x.clean(output.input_check.note.trim(), 'input_check.note', null);
    return {
      status: 'rejected',
      rejection: { code, tips: [...REJECTION_TIPS[code]] },
      inputCheck,
      summary: note || x.t(REJECTED_SUMMARY),
      recordingTips: recordingTips(output, x),
      flags: x.flags,
    };
  }

  const visual = visualStep(output, x);
  const weakAll = overrideStep(weaknessesStep(output, visual, x), x);
  const weakIds = new Set(weakAll.map((w) => w.checkpointId));
  const strengths = strengthsStep(output, visual, x)
    .filter((s) => {
      if (!weakIds.has(s.checkpointId)) return true;
      x.flag('finding_dropped', `strength ${s.checkpointId} is also a weakness`);
      return false;
    })
    .slice(0, POSTPROCESS_LIMITS.strengths);
  const weaknesses = weakAll.slice(0, POSTPROCESS_LIMITS.weaknesses);
  const improvements = improvementsStep(output, weaknesses, x);
  const notes = notesStep(output, x);
  const summary = x.prose(output.summary, 'summary', x.t(GENERIC_SUMMARY));
  return {
    status: 'ok',
    inputCheck,
    visual,
    visualJudgments: visual.map((v) => ({ checkpointId: v.checkpointId, level: v.level, confidence: v.confidence })),
    strengths,
    weaknesses,
    improvements,
    summary,
    ...notes,
    recordingTips: recordingTips(output, x),
    medicalHit: x.medicalHit,
    flags: x.flags,
  };
}

/** The generic note added when the medical filter fired (used by compose). */
export const MEDICAL_NOTE = SEE_PROFESSIONAL_NOTE;
