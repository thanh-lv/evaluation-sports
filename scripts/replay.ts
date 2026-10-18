/**
 * Replays the server pipeline on a pose.v1 file (DESIGN.md §13.1): prepare (engine) now; the Claude step is a
 * clearly marked hook for the Claude module (M6), followed by composeScores.
 *
 *   deno run -A --config supabase/functions/deno.json scripts/replay.ts <pose.json>
 *        [--view side|behind|front|diagonal] [--exclude 1,3] [--handedness right|left] [--frame-mode frames|pose_only]
 *        [--out <dir>]                      write response.json, prepared.json, pose.clean.json there
 *        [--mock-claude <output.json>]      run the (mock) Claude step and compose the final scores
 *   deno run -A --config supabase/functions/deno.json scripts/replay.ts --golden [--check]
 *        write / check the golden prepare responses shared/fixtures/prepare/<synthetic fixture>.json
 */
import { type ConfirmedCameraView, type Handedness, PoseV1, type QuotaPreview } from '@shared/contracts/index.ts';
import {
  composeScores,
  prepare,
  type PreparedAnalysisV1,
  type PrepareOptions,
  type VisualJudgmentInput,
  withQuota,
} from '@shared/engine/index.ts';
import { loadRubric } from '@shared/rubric/load.ts';
import { prettyJson, repoPath } from './_lib/json.ts';
import { SYNTHETIC_FIXTURES } from './gen-synthetic-pose.ts';

/** Fixed owner and quota so golden files are stable. */
export const GOLDEN_USER = '5f8e2c1a-9b7d-4e3f-8a6c-2d1e0f9b8a7c';
export const GOLDEN_QUOTA: QuotaPreview = {
  tier: 'free',
  remaining: 1,
  nextKind: 'standard',
  resetsAt: '2026-11-01T00:00:00+07:00',
};

/** Runs prepare on a pose document (already JSON-parsed). Throws on a rejection. */
export function replayPrepare(input: unknown, opts: Partial<PrepareOptions> = {}) {
  const pose = PoseV1.parse(input);
  const out = prepare(pose, { rubric: loadRubric(pose.session.sport), userId: GOLDEN_USER, ...opts });
  return { pose, out };
}

/** Golden prepare response text for a synthetic fixture name. */
export async function goldenText(name: string): Promise<string> {
  const pose = JSON.parse(await Deno.readTextFile(repoPath(`shared/fixtures/pose/${name}.json`)));
  const { out } = replayPrepare(pose);
  if (!out.ok) throw new Error(`${name}: rejected ${out.code}`);
  return prettyJson(withQuota(out.response, GOLDEN_QUOTA));
}

// ---------------------------------------------------------------------------------------------------------------
// HOOK(M6): the Claude step. The Claude module replaces this function with
//   buildRequest(prepared, frames, language) → runOnce (or a mocked response) → postprocess → visual judgments,
// returning the normalised V judgments (and, later, the whole post-processed output for the result builder).
// Until then a mock output file is read naively: only `visual_checkpoints` is used, so composeScores can be
// exercised end to end.
// ---------------------------------------------------------------------------------------------------------------
async function claudeStep(
  prepared: PreparedAnalysisV1,
  mockPath: string | null,
): Promise<VisualJudgmentInput[] | null> {
  if (!mockPath) return null;
  console.log(`\n[claude] HOOK(M6) not wired yet: reading visual_checkpoints from ${mockPath} only`);
  const raw = JSON.parse(await Deno.readTextFile(mockPath)) as {
    visual_checkpoints?: { checkpoint_id: string; level: number; confidence: string }[];
  };
  const allowed = new Set(prepared.visualToJudge.map((v) => v.checkpointId));
  return (raw.visual_checkpoints ?? [])
    .filter((v) => allowed.has(v.checkpoint_id))
    .map((v) => ({
      checkpointId: v.checkpoint_id,
      level: prepared.frameMode === 'pose_only' ? -1 : Math.max(-1, Math.min(4, Math.round(v.level))),
      confidence:
        (['low', 'medium', 'high'].includes(v.confidence.toLowerCase())
          ? v.confidence.toLowerCase()
          : 'low') as VisualJudgmentInput['confidence'],
    }));
}

function arg(name: string): string | null {
  const i = Deno.args.indexOf(name);
  return i >= 0 && i + 1 < Deno.args.length ? Deno.args[i + 1] : null;
}

function printSummary(prepared: PreparedAnalysisV1): void {
  const p = prepared;
  console.log(`${p.skill} · view ${p.view} (${p.viewSource}; guess ${p.viewGuess.view} ${p.viewGuess.confidence})`);
  console.log(
    `hand ${p.handedness}${
      p.handednessSuggestion ? ` (suggest ${p.handednessSuggestion})` : ''
    } · f ${p.direction.f} (${p.direction.source}) · ${p.analysisHz} Hz · ${p.frameMode}`,
  );
  console.log(`warnings: ${p.warnings.join(', ') || '—'}`);
  console.log('\nstrokes');
  for (const s of p.strokes) {
    console.log(
      `  #${s.id} contact ${(s.tContactUs / 1e6).toFixed(3)} s  vPeak ${
        s.vPeak.toFixed(1)
      } T/s  q ${s.quality}  score ${s.strokeScore ?? '—'}  ${s.excluded ? 'EXCLUDED' : s.role ?? ''}`,
    );
  }
  console.log('\ncheckpoints');
  for (const r of p.checkpointTable) {
    const sc = r.s === null ? '' : `s ${r.s.toFixed(2)} c ${r.c.toFixed(2)}`;
    console.log(
      `  ${r.id.padEnd(20)} ${r.assess.padEnd(2)} ${r.status.padEnd(14)} ${r.valueText.padEnd(10)} ${
        r.targetText.padEnd(12)
      } ${sc}`,
    );
  }
  console.log('\ncandidates');
  for (const w of p.candidates.weaknesses) console.log(`  − ${w.checkpointId} ${w.faultId ?? ''} impact ${w.impact}`);
  for (const s of p.candidates.strengths) console.log(`  + ${s.checkpointId} rank ${s.rank}`);
  for (const i of p.candidates.injury) console.log(`  ! ${i.checkpointId} (safety note)`);
  console.log(`\npreview (measured only), coverage ${p.coverage}`);
  for (const s of p.subScoresPreview) {
    console.log(`  ${s.key.padEnd(9)} ${s.score ?? '—'} cov ${s.coverage}${s.shown ? '' : ' (hidden)'}`);
  }
  console.log(
    `\nvisual to judge: ${p.visualToJudge.map((v) => `${v.checkpointId}[${v.frameIds.join(',')}]`).join(' ') || '—'}`,
  );
  console.log('\nframes');
  for (const f of p.frameRequests) {
    console.log(
      `  ${f.frameId} stroke ${f.strokeId} ${f.phase.padEnd(8)} ${f.tUs} crop ${JSON.stringify(f.crop)} ${
        f.upload ? 'upload' : 'local'
      }`,
    );
  }
}

async function golden(check: boolean): Promise<number> {
  let failed = 0;
  for (const { name } of SYNTHETIC_FIXTURES) {
    const rel = `shared/fixtures/prepare/${name}.json`;
    const text = await goldenText(name);
    if (check) {
      let current = '';
      try {
        current = await Deno.readTextFile(repoPath(rel));
      } catch { /* missing → out of sync */ }
      if (current !== text) {
        console.error(`${rel} is out of sync (run scripts/replay.ts --golden)`);
        failed++;
      } else console.log(`in sync    ${rel}`);
    } else {
      await Deno.writeTextFile(repoPath(rel), text);
      console.log(`wrote      ${rel}`);
    }
  }
  return failed ? 1 : 0;
}

async function main(): Promise<number> {
  if (Deno.args.includes('--golden')) return await golden(Deno.args.includes('--check'));
  const file = Deno.args.find((a, i) => !a.startsWith('--') && (i === 0 || !Deno.args[i - 1].startsWith('--')));
  if (!file) {
    console.error(
      'usage: replay.ts <pose.json> [--view v] [--exclude 1,2] [--handedness h] [--out dir] [--mock-claude f]',
    );
    return 2;
  }
  const exclude = arg('--exclude');
  const { pose, out } = replayPrepare(JSON.parse(await Deno.readTextFile(file)), {
    view: (arg('--view') as ConfirmedCameraView | null) ?? undefined,
    excludedStrokeIds: exclude ? exclude.split(',').map(Number) : undefined,
    handedness: (arg('--handedness') as Handedness | null) ?? undefined,
    frameMode: (arg('--frame-mode') as 'frames' | 'pose_only' | null) ?? undefined,
  });
  if (!out.ok) {
    console.log(`REJECTED ${out.code}: ${out.message}\ntips: ${out.tips.join(', ')}`);
    return 1;
  }
  printSummary(out.prepared);
  const dir = arg('--out');
  if (dir) {
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(`${dir}/response.json`, prettyJson(withQuota(out.response, GOLDEN_QUOTA)));
    await Deno.writeTextFile(`${dir}/prepared.json`, prettyJson(out.prepared));
    await Deno.writeTextFile(`${dir}/pose.clean.json`, JSON.stringify(out.cleanTrack));
    console.log(`\nwrote ${dir}/{response,prepared}.json and pose.clean.json`);
  }
  const judgments = await claudeStep(out.prepared, arg('--mock-claude'));
  if (judgments) {
    const skill = loadRubric(pose.session.sport).skills.find((s) => s.id === out.prepared.skill)!;
    const composed = composeScores(out.prepared.checkpointTable, judgments, skill);
    const o = composed.overall;
    console.log(`\ncomposed: overall ${o.displayScore ?? '—'} (raw ${o.score?.toFixed(1) ?? '—'}) ${o.level ?? ''}`);
    console.log(`  coverage ${o.coverage.toFixed(3)}${o.partial ? ' PARTIAL' : ''}${o.capped ? ' capped at 85' : ''}`);
    for (const s of composed.subScores) console.log(`  ${s.key.padEnd(9)} ${s.displayScore ?? '—'} (${s.confidence})`);
  }
  return 0;
}

if (import.meta.main) Deno.exit(await main());
