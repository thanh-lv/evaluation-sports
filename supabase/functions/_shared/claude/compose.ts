/**
 * Compose step (DESIGN.md §8.4 step 9): engine `composeScores` with the post-processed V judgments, then the full
 * `coach-result.v1` document (catalog texts, server numbers, frames, safety notes, rules tip). Always `access: full`:
 * free redaction happens in SQL (`get_result`). The result is validated before it is returned.
 */
import {
  type AnalysisKind,
  BEST_FRAME_BY_PHASE,
  COACH_SCHEMA_VERSION,
  type CoachResultV1,
  CoachResultV1 as CoachResultSchema,
  type FrameId,
  type Language,
  type LocalizedText,
  OVERVIEW_FRAME_ID,
  type ResultCheckpoint,
  type ResultDrill,
  type ResultEvidence,
  type ResultSafetyNote,
  type ResultSubScore,
  type StrokePhase,
  SUB_SCORE_KEYS,
  WORST_FRAME_BY_PHASE,
} from '../contracts/index.ts';
import type { PreparedAnalysisV1, PreparedStrokeState } from '../engine/prepared_state.ts';
import { type ComposedCheckpoint, type ComposedScores, composeScores } from '../engine/score.ts';
import type { CheckpointDef, CheckpointPhase, DrillDef, RubricBundle } from '../rubric/types.ts';
import { subScoreName } from './glossary.ts';
import { MEDICAL_NOTE, type PEvidence, type PostprocessResult, type PWeakness } from './postprocess.ts';
import { sentence } from './text_clean.ts';
import { PROMPT_VERSION } from './types.ts';

export interface ComposeInput {
  prepared: PreparedAnalysisV1;
  rubric: RubricBundle;
  post: PostprocessResult;
  language: Language;
  kind: AnalysisKind;
  /** `response.model` (model served), or the route model in mock mode. */
  model: string;
  /** ISO 8601 UTC. */
  createdAt: string;
  promptVersion?: string;
}

export interface ComposeOutput {
  result: CoachResultV1;
  /** null for a rejected result. */
  scores: ComposedScores | null;
}

/** Stroke phase whose frame shows a checkpoint (phase frames exist for ready / bsEnd / contact / ftStop only). */
const PHASE_FRAME: Readonly<Record<CheckpointPhase, StrokePhase>> = {
  ready: 'ready',
  bsEnd: 'bsEnd',
  contact: 'contact',
  'contact+0.2': 'ftStop',
  ftStop: 'ftStop',
  recovery: 'ftStop',
  window: 'contact',
};

const r2 = (x: number) => Math.min(1, Math.max(0, Math.round(x * 100) / 100));

class Composer {
  readonly defs: Map<string, CheckpointDef>;
  readonly rows: Map<string, ComposedCheckpoint>;
  readonly strokes: Map<number, PreparedStrokeState>;
  readonly drills: Map<string, DrillDef>;
  readonly frames: Set<FrameId>;

  constructor(readonly input: ComposeInput, readonly scores: ComposedScores | null) {
    const { prepared: p, rubric } = input;
    this.defs = new Map(rubric.checkpoints.map((c) => [c.id, c]));
    this.rows = new Map((scores?.checkpoints ?? []).map((r) => [r.id, r]));
    this.strokes = new Map(p.strokes.filter((s) => !s.excluded).map((s) => [s.id, s]));
    this.drills = new Map(rubric.drills.map((d) => [d.id, d]));
    this.frames = new Set(p.frameRequests.map((f) => f.frameId));
  }

  phaseOf(checkpointId: string): StrokePhase {
    const def = this.defs.get(checkpointId);
    return def ? PHASE_FRAME[def.phase] : 'contact';
  }

  /** Frame of a stroke's phase: F# for the best stroke, L# for the worst (§8.4 step 6); null otherwise. */
  strokeFrame(stroke: PreparedStrokeState | undefined, checkpointId: string): FrameId | null {
    if (!stroke) return null;
    const def = this.defs.get(checkpointId);
    let id: FrameId | null = null;
    if (stroke.role === 'best') {
      id = def?.phase === 'window' ? OVERVIEW_FRAME_ID : BEST_FRAME_BY_PHASE[this.phaseOf(checkpointId)];
    } else if (stroke.role === 'worst') id = WORST_FRAME_BY_PHASE[this.phaseOf(checkpointId)];
    return id && this.frames.has(id) ? id : null;
  }

  bestStroke(): PreparedStrokeState | undefined {
    return [...this.strokes.values()].find((s) => s.role === 'best');
  }

  plainFor(checkpointId: string, kind: 'weakness' | 'strength'): LocalizedText | null {
    const def = this.defs.get(checkpointId);
    if (!def) return null;
    if (kind === 'strength') return { vi: def.plain.vi.ok, en: def.plain.en.ok };
    const cand = this.input.prepared.candidates.weaknesses.find((w) => w.checkpointId === checkpointId);
    if (cand) return cand.plain;
    return { vi: def.plain.vi.low, en: def.plain.en.low };
  }

  detailOf(row: ComposedCheckpoint | undefined): { valueText: string; targetText: string } | null {
    if (!row) return null;
    if (row.status === 'measured') return { valueText: row.valueText, targetText: row.targetText };
    if (row.status === 'visual' && row.visualLevel !== null) {
      return { valueText: `${row.visualLevel}/4`, targetText: '4/4' };
    }
    return null;
  }

  evidence(e: PEvidence, findingId: string, kind: 'weakness' | 'strength'): ResultEvidence {
    const checkpointId = e.metricKey ?? findingId;
    const stroke = e.strokeId > 0 ? this.strokes.get(e.strokeId) : undefined;
    const req = e.frameId ? this.input.prepared.frameRequests.find((f) => f.frameId === e.frameId) : undefined;
    const row = this.rows.get(checkpointId);
    return {
      strokeId: e.strokeId,
      tUs: stroke ? stroke.phases[this.phaseOf(checkpointId)] : req?.tUs ?? null,
      frameId: e.frameId ?? this.strokeFrame(stroke, checkpointId),
      metricKey: e.metricKey,
      observation: e.observation,
      plain: this.plainFor(checkpointId, checkpointId === findingId ? kind : (row?.s ?? 0) >= 0.85 ? 'strength' : kind),
      detail: e.metricKey ? this.detailOf(row) : null,
      joints: row?.joints ?? [],
    };
  }

  drill(id: string): ResultDrill | null {
    const d = this.drills.get(id);
    if (!d) return null;
    return {
      id: d.id,
      title: d.title,
      steps: { vi: [...d.steps.vi], en: [...d.steps.en] },
      dose: { sets: d.dose.sets, reps: d.dose.reps ?? null, seconds: d.dose.seconds ?? null },
      safety: d.safety ?? null,
    };
  }

  cueOf(w: PWeakness): LocalizedText {
    const fault = w.faultId ? this.input.rubric.faults.find((f) => f.id === w.faultId) : undefined;
    if (fault) return fault.cue;
    const def = this.defs.get(w.checkpointId)!;
    return { vi: sentence(def.plain.vi.ok), en: sentence(def.plain.en.ok) };
  }

  checkpoints(): ResultCheckpoint[] {
    return (this.scores?.checkpoints ?? []).map((row) => {
      const def = this.defs.get(row.id)!;
      const judged = row.status === 'visual' && row.visualLevel !== null;
      return {
        id: row.id,
        subscore: row.subscore,
        assess: row.assess,
        s: row.s === null || (row.status === 'visual' && !judged) ? null : r2(row.s),
        c: r2(row.c),
        valueText: judged ? `${row.visualLevel}/4` : row.valueText,
        targetText: judged ? '4/4' : row.targetText,
        perStroke: row.perStroke.map((ps) => ({
          strokeId: ps.strokeId,
          value: typeof ps.value === 'boolean' ? (ps.value ? 1 : 0) : ps.value,
        })),
        name: def.name,
        joints: row.joints,
      };
    });
  }

  subScores(): ResultSubScore[] {
    const sport = this.input.prepared.sport;
    if (!this.scores) {
      return SUB_SCORE_KEYS.map((key) => ({
        key,
        displayScore: null,
        coverage: 0,
        confidence: 'low',
        name: subScoreName(key, sport),
      }));
    }
    return this.scores.subScores.map((s) => ({
      key: s.key,
      displayScore: s.displayScore,
      coverage: r2(s.coverage),
      confidence: s.confidence,
      name: subScoreName(s.key, sport),
    }));
  }

  injuryNotes(): ResultSafetyNote[] {
    const lang = this.input.language;
    return this.input.prepared.candidates.injury.flatMap((hit) => {
      const safety = this.defs.get(hit.checkpointId)?.safety;
      return safety ? [{ kind: 'technique_risk' as const, message: safety[lang], localized: safety, checkpointId: hit.checkpointId }] : [];
    });
  }
}

export function composeResult(input: ComposeInput): ComposeOutput {
  const { prepared: p, rubric, post, language } = input;
  const skill = rubric.skills.find((s) => s.id === p.skill);
  if (!skill) throw new Error(`compose: skill ${p.skill} is not in the ${rubric.sport} rubric`);
  const scores = post.status === 'ok' ? composeScores(p.checkpointTable, post.visualJudgments, skill) : null;
  const k = new Composer(input, scores);

  const base = {
    schema: 'coach-result.v1' as const,
    analysisId: p.analysisId,
    sport: p.sport,
    skill: p.skill,
    narrativeLanguage: language,
    createdAt: input.createdAt,
    access: 'full' as const,
    locked: { strengths: 0, weaknesses: 0, plan: 0 },
    aiGenerated: true as const,
    strokes: [...k.strokes.values()].map((s) => ({
      id: s.id,
      tStartUs: s.tStartUs,
      tContactUs: s.tContactUs,
      contactIsEstimate: s.contactIsEstimate,
      tEndUs: s.tEndUs,
      phases: { ready: s.phases.ready, bsEnd: s.phases.bsEnd, contact: s.phases.contact, ftStop: s.phases.ftStop },
      role: s.role,
    })),
    recordingTips: post.recordingTips,
    rulesTip: skill.rulesTip,
    summary: post.summary,
    meta: {
      model: input.model,
      kind: input.kind,
      promptVersion: input.promptVersion ?? PROMPT_VERSION,
      rubricVersion: p.rubricVersion,
      algoVersion: p.algoVersion,
      schemaVersion: COACH_SCHEMA_VERSION,
    },
  };

  let doc: CoachResultV1;
  if (post.status === 'rejected') {
    doc = {
      ...base,
      status: 'rejected',
      rejection: post.rejection,
      hero: null,
      overall: { displayScore: null, level: null, coverage: 0, partial: true, beta: true },
      subScores: k.subScores(),
      strengths: [],
      weaknesses: [],
      plan: [],
      safety: [],
      notAssessable: [],
    };
  } else {
    const o = scores!.overall;
    const weaknesses = post.weaknesses.map((w) => ({
      checkpointId: w.checkpointId,
      faultId: w.faultId,
      severity: w.severity,
      title: w.title,
      detail: w.detail,
      whyItMatters: w.whyItMatters,
      cue: k.cueOf(w),
      evidence: w.evidence.map((e) => k.evidence(e, w.checkpointId, 'weakness')),
    }));
    const plan = post.improvements.map((m, i) => {
      const row = k.rows.get(m.checkpointId);
      return {
        priority: i + 1,
        faultId: m.faultId,
        title: m.title,
        howToFix: m.howToFix,
        cues: m.cues,
        goal: m.goal,
        target: row?.status === 'measured'
          ? { metricKey: m.checkpointId, current: row.valueText, goal: row.targetText }
          : null,
        drills: m.drillIds.map((id) => k.drill(id)).filter((d): d is ResultDrill => d !== null),
      };
    });
    const heroW = post.weaknesses[0];
    let hero: CoachResultV1['hero'] = null;
    if (heroW) {
      const ev = heroW.evidence[0];
      const stroke = ev && ev.strokeId > 0 ? k.strokes.get(ev.strokeId) : k.bestStroke();
      hero = {
        checkpointId: heroW.checkpointId,
        faultId: heroW.faultId,
        title: heroW.title,
        observation: ev?.observation ?? heroW.detail,
        cue: k.cueOf(heroW),
        drill: plan[0]?.drills[0] ?? null,
        frameId: k.strokeFrame(stroke, heroW.checkpointId) ?? ev?.frameId ?? null,
        joints: k.rows.get(heroW.checkpointId)?.joints ?? [],
      };
    }
    const safety: ResultSafetyNote[] = [
      ...k.injuryNotes(),
      ...(post.medicalHit
        ? [{ kind: 'see_professional' as const, message: MEDICAL_NOTE[language], localized: MEDICAL_NOTE, checkpointId: null }]
        : []),
      ...post.safetyNotes.map((n) => ({ kind: n.kind, message: n.message, localized: null, checkpointId: null })),
    ];
    doc = {
      ...base,
      status: 'succeeded',
      rejection: null,
      hero,
      overall: { displayScore: o.displayScore, level: o.level, coverage: r2(o.coverage), partial: o.partial, beta: true },
      subScores: k.subScores(),
      checkpoints: k.checkpoints(),
      strengths: post.strengths.map((s) => ({
        checkpointId: s.checkpointId,
        title: s.title,
        detail: s.detail,
        evidence: s.evidence.map((e) => k.evidence(e, s.checkpointId, 'strength')),
      })),
      // The hero is not repeated in `weaknesses` (coach_result_v1.ts).
      weaknesses: weaknesses.slice(1),
      plan,
      safety,
      notAssessable: post.notAssessable,
    };
  }

  const parsed = CoachResultSchema.safeParse(doc);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`compose: invalid coach-result.v1: ${issues}`);
  }
  return { result: parsed.data, scores };
}
