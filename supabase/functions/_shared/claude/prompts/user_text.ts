/**
 * The per-request user text (DESIGN.md §8.2): <session>, <quality>, <checkpoints>, <strokes>, <candidates>,
 * <visual_to_judge>, then the last line "Output language: vi|en". Built only from PreparedAnalysisV1 (numbers are
 * owned by code) plus the frames actually sent. Everything after the cached system prefix lives here.
 */
import type { FrameRequest, Language, UploadFrameId } from '../../contracts/index.ts';
import { formatValue } from '../../engine/checkpoints.ts';
import type { CheckpointRow, PreparedAnalysisV1 } from '../../engine/prepared_state.ts';
import type { RubricBundle } from '../../rubric/types.ts';

const f2 = (x: number) => x.toFixed(2);
const secs = (us: number) => `${(us / 1e6).toFixed(2)}s`;

function scalarText(v: number | boolean | null, unit: string | null): string {
  if (v === null) return '-';
  if (typeof v === 'boolean') return v ? '✓' : '✗';
  return formatValue(v, unit ?? '');
}

function sessionBlock(p: PreparedAnalysisV1, rubric: RubricBundle): string {
  const skill = rubric.skills.find((s) => s.id === p.skill);
  const active = p.strokes.filter((s) => !s.excluded).length;
  const excluded = p.strokes.length - active;
  const view = p.viewSource === 'user'
    ? `${p.view} (confirmed by the user; tracking guessed ${p.viewGuess.view}, confidence ${f2(p.viewGuess.confidence)})`
    : `${p.view} (not confirmed; tracking guess, confidence ${f2(p.viewGuess.confidence)})`;
  return [
    '<session>',
    `sport: ${p.sport}`,
    `skill: ${p.skill} (${skill?.name.en ?? p.skill})`,
    `frame_mode: ${p.frameMode}${p.frameMode === 'pose_only' ? ' (no frames are sent)' : ''}`,
    `view: ${view}`,
    `handedness: ${p.handedness}`,
    `analysis: ${p.analysisHz} Hz from a ${Math.round(p.srcFps)} fps source`,
    `strokes analysed: ${active}${excluded ? ` (${excluded} excluded by the user)` : ''}`,
    'contact times: estimated from body tracking',
    '</session>',
  ].join('\n');
}

function qualityBlock(p: PreparedAnalysisV1): string {
  const q = p.inputQuality;
  return [
    '<quality>',
    `tracked frames: ${q.framesWithTarget} of ${q.framesTotal}`,
    `mean limb confidence: ${f2(q.meanLimbConf)}`,
    `player height: ${f2(q.playerHeightFrac)} of the frame`,
    `track resets: ${q.trackResets}`,
    `warnings: ${p.warnings.join(', ') || 'none'}`,
    `measured coverage: ${f2(p.coverage)}`,
    '</quality>',
  ].join('\n');
}

function perStrokeText(row: CheckpointRow): string {
  const used = row.perStroke.filter((ps) => ps.used);
  return used.length ? used.map((ps) => `${ps.strokeId}: ${scalarText(ps.value, row.unit)}`).join(' · ') : '-';
}

function checkpointsBlock(p: PreparedAnalysisV1, rubric: RubricBundle): string {
  const names = new Map(rubric.checkpoints.map((c) => [c.id, c.name.en]));
  const rows = p.checkpointTable.map((r) => {
    const measured = r.status === 'measured';
    return [
      r.id,
      names.get(r.id) ?? r.id,
      r.assess,
      r.status,
      measured ? r.valueText : '-',
      r.targetText || '-',
      measured && r.s !== null ? f2(r.s) : '-',
      measured ? f2(r.c) : '-',
      measured ? perStrokeText(r) : '-',
    ].join(' | ');
  });
  return [
    '<checkpoints>',
    'status: measured = computed from pose; visual = judge it from the frames; view_excluded = not visible from this' +
    ' view; no_data = tracking lost it; not_assessable = cannot be judged from video.',
    'id | name | tag | status | value | target | s | c | per stroke',
    ...rows,
    '</checkpoints>',
  ].join('\n');
}

function strokesBlock(p: PreparedAnalysisV1): string {
  const rows = p.strokes.filter((s) => !s.excluded).map((s) =>
    [
      s.id,
      s.role ?? '-',
      f2(s.quality),
      s.strokeScore === null ? '-' : f2(s.strokeScore),
      secs(s.phases.ready),
      secs(s.phases.bsEnd),
      secs(s.phases.contact),
      secs(s.phases.ftStop),
    ].join(' | ')
  );
  return [
    '<strokes>',
    'id | role | quality | stroke score | ready | end of backswing | contact (estimate) | follow-through',
    ...rows,
    '</strokes>',
  ].join('\n');
}

function candidatesBlock(p: PreparedAnalysisV1, rubric: RubricBundle): string {
  const faults = new Map(rubric.faults.map((f) => [f.id, f]));
  const drillsOf = (faultId: string | null) => {
    const f = faultId ? faults.get(faultId) : undefined;
    return f ? [f.defaultDrill, ...f.drills.filter((d) => d !== f.defaultDrill)].join(', ') : '-';
  };
  const c = p.candidates;
  const lines = ['<candidates>', 'weaknesses (most impact first):'];
  if (c.weaknesses.length) {
    lines.push('rank | checkpoint_id | fault_id | side | impact | s | c | allowed drills (default first)');
    c.weaknesses.forEach((w, i) =>
      lines.push(
        [i + 1, w.checkpointId, w.faultId ?? 'none', w.reading, w.impact.toFixed(3), f2(w.s), f2(w.c), drillsOf(w.faultId)]
          .join(' | '),
      )
    );
  } else lines.push('none');
  lines.push('strengths (strongest first):');
  if (c.strengths.length) {
    lines.push('rank | checkpoint_id | s | c');
    c.strengths.forEach((s, i) => lines.push([i + 1, s.checkpointId, f2(s.s), f2(s.c)].join(' | ')));
  } else lines.push('none');
  if (c.injury.length) {
    lines.push(
      'injury-flagged (the server adds a fixed safety note; do not list these as weaknesses): ' +
        c.injury.map((i) => i.checkpointId).join(', '),
    );
  }
  lines.push('</candidates>');
  return lines.join('\n');
}

function visualBlock(p: PreparedAnalysisV1, sent: ReadonlySet<UploadFrameId>): string {
  const lines = ['<visual_to_judge>'];
  if (!p.visualToJudge.length) lines.push('none');
  else if (p.frameMode === 'pose_only' || sent.size === 0) {
    lines.push('No frames were sent: answer level -1 with confidence low for each of these.');
    lines.push(...p.visualToJudge.map((v) => `${v.checkpointId} | phase ${v.phase}`));
  } else {
    lines.push('checkpoint_id | phase | frames | view factor (anchors are in the rubric)');
    for (const v of p.visualToJudge) {
      const frames = v.frameIds.filter((f) => sent.has(f));
      lines.push([v.checkpointId, v.phase, frames.join(', ') || '- (answer -1)', v.viewFactor].join(' | '));
    }
  }
  lines.push('</visual_to_judge>');
  return lines.join('\n');
}

/** Label text placed before each image block. */
export function frameLabel(req: FrameRequest, roleOf: (strokeId: number) => string | null): string {
  const role = roleOf(req.strokeId);
  return `${req.frameId} · stroke ${req.strokeId}${role ? ` (${role})` : ''} · phase=${req.phase} · t=${secs(req.tUs)}`;
}

export function buildUserText(
  p: PreparedAnalysisV1,
  rubric: RubricBundle,
  language: Language,
  sentFrameIds: ReadonlySet<UploadFrameId>,
): string {
  return [
    sessionBlock(p, rubric),
    qualityBlock(p),
    checkpointsBlock(p, rubric),
    strokesBlock(p),
    candidatesBlock(p, rubric),
    visualBlock(p, sentFrameIds),
    `Output language: ${language}`,
  ].join('\n\n');
}
