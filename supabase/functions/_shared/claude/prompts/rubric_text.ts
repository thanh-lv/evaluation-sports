/**
 * RUBRIC_TEXT[sport] (DESIGN.md §8.2, contents per DESIGN-v1.0 §8.2): the second system block, carrying the cache
 * breakpoint. Rendered deterministically from the rubric JSON in English only, so it is byte-identical across
 * languages and users (one cache prefix per model × sport). Covers every skill, enabled or not, like the schema.
 */
import { type Sport, SUB_SCORE_KEYS, type SubScoreKey } from '../../contracts/common.ts';
import { targetText } from '../../engine/checkpoints.ts';
import { loadRubric } from '../../rubric/load.ts';
import type { CheckpointDef, DrillDef, FaultDef, RubricBundle, SkillDef } from '../../rubric/types.ts';

const SUB_SCORE_MEANING: Readonly<Record<SubScoreKey, string>> = {
  stance: 'ready position, base width, knee bend, balance',
  footwork: 'split step, steps and lunges into the hitting position',
  swing: 'body turn, backswing, elbow and arm path',
  contact: 'contact height, position in front of the body, arm extension',
  follow: 'follow-through direction and finish',
  recovery: 'returning to a balanced ready position after the stroke',
};

const TAG_MEANING =
  'Tags: M = measured from pose; M~ = measured, rough; V = you judge it from the frames (level 0-4);' +
  ' N = not assessable from video (mention it under not_assessable when relevant).';

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function skillLine(s: SkillDef): string {
  const w = SUB_SCORE_KEYS.map((k) => `${k} ${s.weights[k]}`).join(', ');
  return [
    `### ${s.id} — ${s.name.en}`,
    `family: ${s.family}; views recommended ${s.views.recommended.join('/')}, allowed ${s.views.allowed.join('/')}`,
    `sub-score weights: ${w}`,
    `checkpoints: ${s.checkpoints.join(', ')}`,
  ].join('\n');
}

function checkpointBlock(c: CheckpointDef, faultsByCheckpoint: Map<string, FaultDef[]>): string {
  const views = `S ${c.views.S} / B ${c.views.B} / D ${c.views.D}`;
  const target = c.metric ? `target ${targetText(c.metric)}${c.metric.unit === 'ratio' ? ' (ratio)' : ''}` : '';
  const head = [
    `- ${c.id} | ${c.name.en} | ${c.assess} | phase ${c.phase} | ${c.subscore} | weight ${c.weight}`,
    `views ${views}`,
    target,
    c.velocityBased ? 'velocity-based' : '',
    c.injuryFlag ? 'injury-flag (the server adds a fixed safety note)' : '',
  ].filter(Boolean).join(' | ');
  const lines = [head];
  if (c.vAnchors) c.vAnchors.forEach((a, i) => lines.push(`    level ${i}: ${oneLine(a)}`));
  const faults = faultsByCheckpoint.get(c.id) ?? [];
  if (faults.length) lines.push(`    faults: ${faults.map((f) => `${f.id} (${f.when})`).join(', ')}`);
  return lines.join('\n');
}

function faultLine(f: FaultDef): string {
  const others = f.drills.filter((d) => d !== f.defaultDrill);
  return `- ${f.id} | checkpoint ${f.checkpoint} | when ${f.when} | ${oneLine(f.title.en)} | cue "${
    oneLine(f.cue.en)
  }" | drills ${[f.defaultDrill, ...others].join(', ')} (default first)`;
}

function drillLine(d: DrillDef): string {
  const dose = `${d.dose.sets} sets${d.dose.reps ? ` × ${d.dose.reps} reps` : ''}${
    d.dose.seconds ? ` × ${d.dose.seconds} s` : ''
  }`;
  return `- ${d.id} | ${oneLine(d.title.en)} | ${dose} | ${oneLine(d.steps.en[0] ?? '')}`;
}

/** Pure renderer (exported for tests); production code uses `rubricText(sport)`. */
export function renderRubricText(rubric: RubricBundle): string {
  const faultsByCheckpoint = new Map<string, FaultDef[]>();
  for (const f of rubric.faults) {
    const list = faultsByCheckpoint.get(f.checkpoint) ?? [];
    list.push(f);
    faultsByCheckpoint.set(f.checkpoint, list);
  }
  const parts = [
    `# Rubric: ${rubric.sport} (${rubric.version})`,
    '## Sub-scores',
    SUB_SCORE_KEYS.map((k) => `- ${k}: ${SUB_SCORE_MEANING[k]}`).join('\n'),
    '## Skills',
    rubric.skills.map(skillLine).join('\n\n'),
    '## Checkpoints',
    `${TAG_MEANING}\nView factors: S = side, B = behind (front uses B, mirrored), D = 45° diagonal; 0 = not visible ` +
    'from that view. Levels for V items: 0 = clearly wrong … 4 = correct, as the anchors describe.',
    rubric.checkpoints.map((c) => checkpointBlock(c, faultsByCheckpoint)).join('\n'),
    '## Faults',
    'when = the reading that triggers the fault: low / high = below / above the target band, false = a check that' +
    ' failed. Use only the drills listed for the fault.',
    rubric.faults.map(faultLine).join('\n'),
    '## Drills',
    rubric.drills.map(drillLine).join('\n'),
  ];
  return parts.join('\n\n');
}

const cache = new Map<Sport, string>();

export function rubricText(sport: Sport): string {
  let t = cache.get(sport);
  if (t === undefined) {
    t = renderRubricText(loadRubric(sport));
    cache.set(sport, t);
  }
  return t;
}
