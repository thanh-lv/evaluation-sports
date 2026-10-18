/**
 * `prepare` / `reprepare` (DESIGN.md §6.1–§6.2, §7.2–§7.3): the whole server-side engine for one clip.
 *
 * validate (caller) → normalize → mirror swap → limb swap fix → Hampel → resample + gap fill → SG → handedness →
 * segment → phases → direction → view guess → stroke quality → metrics + checkpoints → rank → candidates →
 * sub-score preview → frame plan → warnings → clean-track export.
 *
 * Pure and deterministic: the same pose and options always give the same output, and stroke ids depend only on the
 * pose and the handedness, so `excludedStrokeIds` from a previous response stay valid across view changes. The
 * caller parses the body with `PoseV1` first, adds `quota` to the response, and stores `prepared` in
 * `analyses.prepared` and `cleanTrack` as `pose.clean.json`.
 */
import {
  type ConfirmedCameraView,
  type FrameMode,
  type Handedness,
  type PrepareRejectionCode,
  REJECTION_TIPS,
  type TipKey,
  VIEW_CODE_TO_CAMERA_VIEW,
  type ViewCode,
} from '../contracts/common.ts';
import type { CleanTrackV1 } from '../contracts/clean_track.ts';
import { frameModeForPose, type PoseV1 } from '../contracts/pose_v1.ts';
import {
  MAX_LONG_EDGE,
  PREPARE_WARNINGS,
  type PrepareResponseV1,
  type PrepareWarning,
  type QuotaPreview,
} from '../contracts/prepare_v1.ts';
import type { ReprepareV1 } from '../contracts/reprepare_v1.ts';
import type { RubricBundle, SkillDef } from '../rubric/types.ts';
import { buildCandidates } from './candidates.ts';
import { evaluateCheckpoints } from './checkpoints.ts';
import { exportCleanTrack } from './clean_track_export.ts';
import { hittingDirection } from './direction.ts';
import { planFrames } from './frameplan.ts';
import { hampelFilter } from './hampel.ts';
import { checkHandedness } from './handedness.ts';
import { buildMetricContext, evaluateMetric } from './metrics.ts';
import { normalizePose } from './normalize.ts';
import { computePhases } from './phases.ts';
import {
  ALGO_VERSION,
  type CheckpointRow,
  PREPARED_SCHEMA,
  type PreparedAnalysisV1,
  type PreparedStrokeState,
  type VisualToJudge,
} from './prepared_state.ts';
import { rankStrokes, strokeQuality, strokeScores } from './rank.ts';
import { resampleTrack } from './resample.ts';
import { smoothTrack } from './savgol.ts';
import { previewSubScores } from './score.ts';
import { segmentStrokes } from './segment.ts';
import { median } from './signal_util.ts';
import { applyMirrorSwap, fixLimbSwaps } from './swapfix.ts';
import { type AnalysisHz, EngineRejection, type StrokePhases } from './types.ts';
import { guessView, VIEW_CONSTANTS } from './viewcheck.ts';

/** Input gates (the device gates at 25 % player height; DESIGN.md §5.4). */
export const PREPARE_GATES = {
  minTargetShare: 0.5,
  minPlayerHeight: 0.25,
  smallPlayerBelow: 0.35,
  lowFps: 30,
  /** Racket wrist missing on more than this share of the grid → low_visibility. */
  maxWristMissing: 0.6,
  /** Median wristH (T above root) at contact: overhead skills below this, underarm above the next → mismatch. */
  overheadMinWristH: 0.9,
  underarmMaxWristH: 1.6,
} as const;

/** prepare.v1 without `quota` (the handler adds it from the database). */
export type PrepareResponseCore = Omit<PrepareResponseV1, 'quota'>;

export interface PrepareOptions {
  rubric: RubricBundle;
  /** Skill (definition or id); defaults to `pose.session.skill`. */
  skill?: SkillDef | string;
  /** Confirmed view; omitted or `auto` → the pose's cameraView, or viewGuess when that is `auto`. */
  view?: ConfirmedCameraView | 'auto';
  /** Stroke ids (from a previous response for the same pose and handedness) the user unticked. */
  excludedStrokeIds?: readonly number[];
  /** Overrides `pose.session.handedness` (reprepare after a handedness answer). */
  handedness?: Handedness;
  /** Defaults to frameModeForPose(pose) (pose_only for minors). */
  frameMode?: FrameMode;
  /** Owner uid, for `cleanTrackPath`; the literal "{uid}" when omitted (tests, replay). */
  userId?: string;
  /** Stored as `prepared.rubricVersion` (pass the sha256 from rubricVersion()); defaults to the bundle version. */
  rubricVersion?: string;
  /** When given, filled with per-stage wall times in ms (bench). */
  timings?: Record<string, number>;
}

export interface PrepareSuccess {
  ok: true;
  response: PrepareResponseCore;
  prepared: PreparedAnalysisV1;
  cleanTrack: CleanTrackV1;
}

export interface PrepareRejection {
  ok: false;
  code: PrepareRejectionCode;
  tips: TipKey[];
  message: string;
}

export type PrepareOutcome = PrepareSuccess | PrepareRejection;

/** Storage path of the clean track in `analysis-derived`. */
export function cleanTrackPath(userId: string, analysisId: string): string {
  return `${userId}/${analysisId}/pose.clean.json`;
}

/** Adds the quota preview to a prepare response. */
export function withQuota(response: PrepareResponseCore, quota: QuotaPreview): PrepareResponseV1 {
  return { ...response, quota };
}

function reject(code: PrepareRejectionCode, message: string): PrepareRejection {
  return { ok: false, code, tips: [...REJECTION_TIPS[code]], message };
}

/** Runs the engine on a parsed pose.v1. Engine rejections come back as `{ok:false}`; bugs still throw. */
export function prepare(pose: PoseV1, opts: PrepareOptions): PrepareOutcome {
  try {
    return run(pose, opts);
  } catch (e) {
    if (e instanceof EngineRejection) return reject(e.code, e.message);
    throw e;
  }
}

/** Re-runs prepare on the stored raw pose with the user's confirmed choices (DESIGN.md §7.2). */
export function reprepare(
  rawPose: PoseV1,
  req: Pick<ReprepareV1, 'cameraView' | 'excludedStrokeIds' | 'handedness'>,
  opts: Omit<PrepareOptions, 'view' | 'excludedStrokeIds' | 'handedness'>,
): PrepareOutcome {
  return prepare(rawPose, {
    ...opts,
    view: req.cameraView,
    excludedStrokeIds: req.excludedStrokeIds,
    handedness: req.handedness,
  });
}

function run(pose: PoseV1, opts: PrepareOptions): PrepareOutcome {
  const timings = opts.timings;
  let lapT = performance.now();
  const lap = (name: string) => {
    if (!timings) return;
    const now = performance.now();
    timings[name] = (timings[name] ?? 0) + (now - lapT);
    lapT = now;
  };

  const { rubric } = opts;
  const skillId = typeof opts.skill === 'string' ? opts.skill : opts.skill?.id ?? pose.session.skill;
  const skill = typeof opts.skill === 'object' ? opts.skill : rubric.skills.find((s) => s.id === skillId);
  if (!skill || skill.sport !== pose.session.sport || rubric.sport !== pose.session.sport) {
    return reject('skill_not_available', `skill ${skillId} is not in the ${pose.session.sport} rubric`);
  }
  const q = pose.quality;
  if (q.framesTotal > 0 && q.framesWithTarget / q.framesTotal < PREPARE_GATES.minTargetShare) {
    return reject('target_lost', `target visible in ${q.framesWithTarget}/${q.framesTotal} frames`);
  }
  if (q.playerHeightFrac < PREPARE_GATES.minPlayerHeight) {
    return reject('player_too_small', `player height ${q.playerHeightFrac}`);
  }
  const declared = opts.handedness ?? pose.session.handedness;
  const hz = pose.video.analysisHz as AnalysisHz;
  const frameMode = opts.frameMode ?? frameModeForPose(pose);

  // Signal stages (M4a/M4b).
  const normalized = normalizePose(pose);
  const swapped = fixLimbSwaps(applyMirrorSwap(normalized));
  const cleaned = hampelFilter(swapped.track).track;
  lap('clean');
  const track = smoothTrack(resampleTrack(cleaned, hz));
  lap('resample+sg');
  const hand = checkHandedness(track, declared);
  // When the declared hand yields no stroke but the speed peaks say the other hand swings, segment with that hand:
  // the response carries handednessSuggestion, so the app asks instead of showing a misleading "no strokes".
  let handedness = declared;
  let seg = segmentStrokes(track, handedness, skill);
  if (!seg.ok && hand.suggestion !== null) {
    const retry = segmentStrokes(track, hand.suggestion, skill);
    if (retry.ok) {
      handedness = hand.suggestion;
      seg = retry;
    }
  }
  const wrist = handedness === 'left' ? 'lWri' : 'rWri';
  const missing = track.joints[wrist].x.filter((x) => x === null).length / track.tUs.length;
  if (missing > PREPARE_GATES.maxWristMissing) {
    return reject('low_visibility', `racket wrist missing on ${Math.round(missing * 100)}% of the clip`);
  }
  if (!seg.ok) return reject('no_strokes_detected', `no wrist-speed peak ≥ ${seg.threshold.toFixed(2)} T/s`);
  const phases = computePhases(track, seg.strokes, handedness);
  const direction = hittingDirection(track, seg.strokes, handedness, phases.map((p) => p.readyWindow));
  lap('segment+phases');

  // View: the confirmed one scores; the guess only warns.
  const viewGuess = guessView(track, phases, pose.video.mirrored);
  const requested = opts.view && opts.view !== 'auto' ? opts.view : pose.session.cameraView;
  const view: ConfirmedCameraView = requested === 'auto' ? viewGuess.view : requested;
  const viewSource = requested === 'auto' ? 'guess' as const : 'user' as const;

  const known = new Set(seg.strokes.map((s) => s.id));
  const excluded = new Set((opts.excludedStrokeIds ?? []).filter((id) => known.has(id)));
  if (excluded.size === seg.strokes.length) {
    return reject('no_strokes_detected', 'every detected stroke was excluded');
  }
  const quality = new Map(phases.map((p) => [p.strokeId, strokeQuality(track, p)]));
  const ctx = buildMetricContext({
    track,
    handedness,
    view,
    f: direction.f,
    mirrored: pose.video.mirrored,
    strokes: phases,
  });
  const table = evaluateCheckpoints({
    skill,
    checkpoints: rubric.checkpoints,
    ctx,
    phases,
    hz,
    view,
    quality,
    excluded,
  });
  lap('metrics+checkpoints');

  const scores = strokeScores(table, seg.strokes.map((s) => s.id));
  const { best, worst } = rankStrokes(seg.strokes.map((s) => ({
    id: s.id,
    quality: quality.get(s.id) ?? 0,
    excluded: excluded.has(s.id),
    score: scores.get(s.id) ?? null,
  })));
  if (best === null) return reject('no_strokes_detected', 'no rankable stroke');
  const candidates = buildCandidates(table, skill, rubric.faults);
  const preview = previewSubScores(table, skill);
  const phaseById = new Map(phases.map((p) => [p.strokeId, p]));
  const frameRequests = planFrames({
    raw: track.raw,
    phases: phaseById,
    best,
    worst,
    handedness,
    sport: skill.sport,
    frameMode,
  });
  lap('rank+frames');

  const strokes: PreparedStrokeState[] = seg.strokes.map((s) => {
    const p = phaseById.get(s.id) as StrokePhases;
    const role = s.id === best ? 'best' as const : s.id === worst ? 'worst' as const : null;
    const metrics: Record<string, number | boolean | null> = {};
    for (const row of table) {
      if (row.metricKey === null) continue;
      metrics[row.id] = row.perStroke.find((x) => x.strokeId === s.id)?.value ?? null;
    }
    return {
      id: s.id,
      tStartUs: p.tStartUs,
      tContactUs: Math.min(Math.max(s.tContactUs, p.tStartUs), p.tEndUs),
      contactIsEstimate: s.contactIsEstimate,
      tEndUs: p.tEndUs,
      vPeak: Math.round(s.vPeak * 1000) / 1000,
      phases: {
        swingStart: p.swingStart?.snappedUs ?? null,
        ready: p.ready.snappedUs,
        bsEnd: p.bsEnd.snappedUs,
        contact: p.contact.snappedUs,
        ftStop: p.ftStop.snappedUs,
        recovery: p.recovery?.snappedUs ?? null,
      },
      readyAssessable: p.readyAssessable,
      quality: quality.get(s.id) ?? 0,
      role: excluded.has(s.id) ? null : role,
      excluded: excluded.has(s.id),
      strokeScore: scores.get(s.id) ?? null,
      metrics,
    };
  });

  const warnings = collectWarnings({
    pose,
    skill,
    view,
    viewGuess,
    viewConfirmed: opts.view !== undefined && opts.view !== 'auto',
    includedCount: seg.strokes.length - excluded.size,
    handednessSuggestion: hand.suggestion,
    contactWristH: seg.strokes
      .filter((s) => !excluded.has(s.id))
      .map((s) => evaluateMetric('wristH', { arm: 'racket' }, ctx, phaseById.get(s.id) as StrokePhases, 'contact'))
      .map((m) => m.value)
      .filter((v): v is number => typeof v === 'number'),
  });

  const response: PrepareResponseCore = {
    schema: 'prepare.v1',
    analysisId: pose.analysisId,
    status: 'prepared',
    frameMode,
    warnings,
    viewGuess: { view: viewGuess.view, confidence: viewGuess.confidence },
    handednessSuggestion: hand.suggestion,
    strokes: strokes.map((s) => ({
      id: s.id,
      tStartUs: s.tStartUs,
      tContactUs: s.tContactUs,
      contactIsEstimate: s.contactIsEstimate,
      tEndUs: s.tEndUs,
      phases: { ready: s.phases.ready, bsEnd: s.phases.bsEnd, contact: s.phases.contact, ftStop: s.phases.ftStop },
      quality: s.quality,
      role: s.role,
      thumbTUs: s.phases.contact,
      excluded: s.excluded,
    })),
    frameRequests,
    maxLongEdge: MAX_LONG_EDGE,
    cleanTrackPath: cleanTrackPath(opts.userId ?? '{uid}', pose.analysisId),
  };

  const prepared: PreparedAnalysisV1 = {
    schema: PREPARED_SCHEMA,
    analysisId: pose.analysisId,
    algoVersion: ALGO_VERSION,
    rubricVersion: opts.rubricVersion ?? rubric.version,
    sport: skill.sport,
    skill: skill.id,
    view,
    viewSource,
    viewGuess: response.viewGuess,
    handedness,
    handednessSuggestion: hand.suggestion,
    direction: { f: direction.f, source: direction.source },
    analysisHz: hz,
    srcFps: pose.video.srcFps,
    frameMode,
    inputQuality: pose.quality,
    strokes,
    checkpointTable: table,
    visualToJudge: visualToJudge(table, rubric, frameMode),
    candidates,
    subScoresPreview: preview.subScores,
    coverage: preview.coverage,
    warnings,
    frameRequests,
  };
  const cleanTrack = exportCleanTrack({
    analysisId: pose.analysisId,
    algoVersion: ALGO_VERSION,
    track,
    display: pose.video.display,
    mirrored: pose.video.mirrored,
    strokes,
  });
  lap('export');
  return { ok: true, response, prepared, cleanTrack };
}

/** Uploaded frames that show a checkpoint phase (Claude judges V checkpoints from these). */
const FRAMES_FOR_PHASE: Readonly<Record<CheckpointRow['phase'], VisualToJudge['frameIds']>> = {
  ready: ['F1'],
  bsEnd: ['F2'],
  contact: ['F3', 'F5'],
  'contact+0.2': ['F3', 'F4'],
  ftStop: ['F4'],
  recovery: ['F4', 'F5'],
  window: ['F1', 'F2', 'F3', 'F4'],
};

/** V checkpoints Claude must judge: every V row whose view factor is non-zero, with its anchors and frames. */
export function visualToJudge(table: readonly CheckpointRow[], rubric: RubricBundle, frameMode: FrameMode) {
  const defs = new Map(rubric.checkpoints.map((c) => [c.id, c]));
  const out: VisualToJudge[] = [];
  for (const row of table) {
    if (row.status !== 'visual' || row.viewFactor === 0) continue;
    const anchors = defs.get(row.id)?.vAnchors;
    if (!anchors) continue;
    out.push({
      checkpointId: row.id,
      phase: row.phase,
      anchors: [...anchors],
      frameIds: frameMode === 'frames' ? [...FRAMES_FOR_PHASE[row.phase]] : [],
      viewFactor: row.viewFactor,
    });
  }
  return out;
}

interface WarningInput {
  pose: PoseV1;
  skill: SkillDef;
  view: ConfirmedCameraView;
  viewGuess: { view: ConfirmedCameraView; confidence: number };
  viewConfirmed: boolean;
  includedCount: number;
  handednessSuggestion: Handedness | null;
  contactWristH: number[];
}

/** Warnings in PREPARE_WARNINGS order (stable for golden files). */
export function collectWarnings(w: WarningInput): PrepareWarning[] {
  const G = PREPARE_GATES;
  const set = new Set<PrepareWarning>();
  if (w.pose.video.analysisHz === 30 || w.pose.video.srcFps < G.lowFps) set.add('fps_low');
  const lowConf = w.viewGuess.confidence < VIEW_CONSTANTS.lowConfidence;
  // Once the user confirmed a view on the confirm screen, asking again is noise.
  if (lowConf && !w.viewConfirmed) set.add('view_low_confidence');
  if (!lowConf && w.viewGuess.view !== w.view) set.add('view_mismatch');
  const recommended = w.skill.views.recommended.map((c: ViewCode) => VIEW_CODE_TO_CAMERA_VIEW[c]);
  if (!recommended.includes(w.view)) set.add('view_not_recommended');
  const wristH = median(w.contactWristH);
  if (Number.isFinite(wristH)) {
    if (w.skill.family === 'overhead' && wristH < G.overheadMinWristH) set.add('skill_mismatch_suspected');
    if (w.skill.family === 'underarm' && wristH > G.underarmMaxWristH) set.add('skill_mismatch_suspected');
  }
  if (w.includedCount <= 2) set.add('few_strokes');
  const ph = w.pose.quality.playerHeightFrac;
  if (ph >= G.minPlayerHeight && ph < G.smallPlayerBelow) set.add('player_small');
  if (w.handednessSuggestion !== null) set.add('handedness_mismatch');
  return PREPARE_WARNINGS.filter((x) => set.has(x));
}
