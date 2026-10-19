/**
 * Replays the server pipeline on a pose.v1 file (DESIGN.md §13.1): prepare (engine), then optionally the Claude step
 * (build_request → mock/fixture model → runOnce → postprocess → compose) producing a coach-result.v1.
 *
 *   deno run -A --config supabase/functions/deno.json scripts/replay.ts <pose.json>
 *        [--view side|behind|front|diagonal] [--exclude 1,3] [--handedness right|left] [--frame-mode frames|pose_only]
 *        [--out <dir>]                      write response.json, prepared.json, pose.clean.json (+ request.json,
 *                                           result.json with a Claude step) there
 *        [--mock]                           Claude step with the built-in mock generator (CLAUDE_MODE=mock)
 *        [--mock-claude <output.json>]      Claude step answering with a coach.v1 fixture (shared/fixtures/claude/)
 *        [--lang vi|en] [--kind basic|standard] [--no-frames]
 *   deno run -A --config supabase/functions/deno.json scripts/replay.ts --golden [--check]
 *        write / check the golden prepare responses shared/fixtures/prepare/<synthetic fixture>.json and the golden
 *        mock results shared/fixtures/results/replay_<fixture>.<lang>.json (GOLDEN_RESULTS)
 * No network: the live model is exercised only by scripts/smoke-claude.ts.
 */
import {
  type AnalysisKind,
  type ConfirmedCameraView,
  type Handedness,
  type Language,
  PoseV1,
  type QuotaPreview,
} from '@shared/contracts/index.ts';
import { prepare, type PreparedAnalysisV1, type PrepareOptions, withQuota } from '@shared/engine/index.ts';
import { loadRubric } from '@shared/rubric/load.ts';
import {
  type CoachAttemptResult,
  type CoachModelClient,
  DEFAULT_MODEL_ROUTES,
  type FrameImage,
  mockCoachClient,
  runCoachAttempt,
  staticCoachClient,
} from '@shared/claude/index.ts';
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
// Claude step (M6)

/** Fixed timestamp so replayed results are stable. */
export const GOLDEN_CREATED_AT = '2026-10-20T08:00:00Z';

/** Golden mock results checked by `--golden --check` (fixture name, narrative language). */
export const GOLDEN_RESULTS: readonly { name: string; lang: Language }[] = [
  { name: 'synthetic_bd_clear_fh_60', lang: 'vi' },
  { name: 'synthetic_pb_dink_60', lang: 'en' },
];

/** Stand-in JPEG payload: the mock never decodes images, and replay never calls the live API. */
const PLACEHOLDER_JPEG = '/9j/placeholder';

export interface ClaudeStepOptions {
  language?: Language;
  kind?: AnalysisKind;
  /** null → built-in mock generator; otherwise a coach.v1 output document (already parsed). */
  fixture?: unknown;
  /** Attach the uploaded frames (default true; pose_only never attaches any). */
  frames?: boolean;
  createdAt?: string;
}

/** Runs the Claude step on a prepared analysis with the mock generator or a fixture output. */
export function replayClaude(prepared: PreparedAnalysisV1, opts: ClaudeStepOptions = {}): Promise<CoachAttemptResult> {
  const language = opts.language ?? 'vi';
  const rubric = loadRubric(prepared.sport);
  const frames: FrameImage[] = opts.frames === false ? [] : prepared.frameRequests
    .filter((f) => f.upload)
    .map((f) => ({ frameId: f.frameId as FrameImage['frameId'], jpegBase64: PLACEHOLDER_JPEG }));
  const fixture = opts.fixture;
  return runCoachAttempt({
    prepared,
    rubric,
    language,
    route: DEFAULT_MODEL_ROUTES[opts.kind ?? 'standard'],
    frames,
    kind: opts.kind ?? 'standard',
    createdAt: opts.createdAt ?? GOLDEN_CREATED_AT,
    client: (req): CoachModelClient =>
      fixture === undefined || fixture === null
        ? mockCoachClient({ prepared, rubric, language, sentFrameIds: req.sentFrameIds })
        : staticCoachClient(() => fixture, 'ok', 'fixture'),
  });
}

/** Golden mock result text for a synthetic fixture. */
export async function goldenResultText(name: string, lang: Language): Promise<string> {
  const pose = JSON.parse(await Deno.readTextFile(repoPath(`shared/fixtures/pose/${name}.json`)));
  const { out } = replayPrepare(pose);
  if (!out.ok) throw new Error(`${name}: rejected ${out.code}`);
  const attempt = await replayClaude(out.prepared, { language: lang });
  if (!attempt.composed) throw new Error(`${name}: Claude step outcome ${attempt.run.outcome.kind}`);
  return prettyJson(attempt.composed.result);
}

/** request.json for --out: the request with image data elided. */
function redactedRequest(attempt: CoachAttemptResult): unknown {
  return JSON.parse(JSON.stringify(attempt.request.params, (k, v) => (k === 'data' ? `<${String(v).length} b64>` : v)));
}

function printAttempt(a: CoachAttemptResult): void {
  const { outcome, call } = a.run;
  console.log(
    `\n[claude] ${call.modelRequested} → ${outcome.kind}; frames sent: ${a.request.sentFrameIds.join(',') || '—'}`,
  );
  if (outcome.kind !== 'ok' || !a.post || !a.composed) {
    console.log(`  ${call.error ?? ''}`);
    return;
  }
  for (const f of a.post.flags) console.log(`  flag ${f.type}: ${f.detail}`);
  const r = a.composed.result;
  if (r.status === 'rejected') {
    console.log(`  REJECTED ${r.rejection?.code} tips ${r.rejection?.tips.join(', ')}`);
    return;
  }
  const o = r.overall;
  console.log(
    `  overall ${o.displayScore ?? '—'} ${o.level ?? ''} coverage ${o.coverage}${o.partial ? ' PARTIAL' : ''}`,
  );
  for (const s of r.subScores) console.log(`  ${s.key.padEnd(9)} ${s.displayScore ?? '—'} (${s.confidence})`);
  console.log(
    `  hero: ${
      r.hero ? `${r.hero.checkpointId} ${r.hero.faultId ?? ''} "${r.hero.title}" ${r.hero.frameId ?? ''}` : '—'
    }`,
  );
  for (const w of r.weaknesses) console.log(`  − ${w.checkpointId} ${w.faultId ?? ''} "${w.title}"`);
  for (const s of r.strengths) console.log(`  + ${s.checkpointId} "${s.title}"`);
  for (const p of r.plan) {
    console.log(`  plan ${p.priority}: ${p.faultId ?? ''} drills ${p.drills.map((d) => d.id).join(', ')}`);
  }
  console.log(`  summary: ${r.summary}`);
}

/** Flags followed by a value (every other `--flag` is boolean). */
const VALUE_FLAGS = new Set([
  '--view',
  '--exclude',
  '--handedness',
  '--frame-mode',
  '--out',
  '--mock-claude',
  '--lang',
  '--kind',
]);

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
  for (const { name, lang } of GOLDEN_RESULTS) {
    const rel = `shared/fixtures/results/replay_${name}.${lang}.json`;
    const text = await goldenResultText(name, lang);
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
  const file = Deno.args.find((a, i) => !a.startsWith('--') && (i === 0 || !VALUE_FLAGS.has(Deno.args[i - 1])));
  if (!file) {
    console.error(
      'usage: replay.ts <pose.json> [--view v] [--exclude 1,2] [--handedness h] [--out dir] [--mock | --mock-claude f]' +
        ' [--lang vi|en] [--kind basic|standard] [--no-frames]',
    );
    return 2;
  }
  const exclude = arg('--exclude');
  const { out } = replayPrepare(JSON.parse(await Deno.readTextFile(file)), {
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
  const fixturePath = arg('--mock-claude');
  if (fixturePath || Deno.args.includes('--mock')) {
    const lang = (arg('--lang') ?? 'vi') as Language;
    if (lang !== 'vi' && lang !== 'en') throw new Error('--lang must be vi or en');
    const kind = (arg('--kind') ?? 'standard') as AnalysisKind;
    const attempt = await replayClaude(out.prepared, {
      language: lang,
      kind,
      fixture: fixturePath ? JSON.parse(await Deno.readTextFile(fixturePath)) : null,
      frames: !Deno.args.includes('--no-frames'),
    });
    printAttempt(attempt);
    if (dir) {
      await Deno.writeTextFile(`${dir}/request.json`, prettyJson(redactedRequest(attempt)));
      if (attempt.composed) await Deno.writeTextFile(`${dir}/result.json`, prettyJson(attempt.composed.result));
      console.log(`wrote ${dir}/request.json${attempt.composed ? ' and result.json' : ''}`);
    }
    if (!attempt.composed) return 1;
  }
  return 0;
}

if (import.meta.main) Deno.exit(await main());
