/**
 * Engine benchmark (DESIGN.md §12 M4d, §13.1): a 30 s 60 Hz synthetic clip (12 strokes) through prepare().
 * Prints per-stage times, the prepare total (target < 300 ms excluding JSON parse) and, separately, JSON.parse +
 * PoseV1 (Zod) of the same payload padded to just under the 1.2 MB request limit. The first runs are warm-up and
 * not counted (JIT), matching how the hosted function behaves after its first request.
 *
 *   deno run -A --config supabase/functions/deno.json scripts/bench-engine.ts [--runs 10] [--json]
 * Exit code 1 when the median prepare time is ≥ the budget.
 */
import { POSE_V1_MAX_BYTES, PoseV1 } from '@shared/contracts/index.ts';
import { prepare } from '@shared/engine/index.ts';
import { loadRubric } from '@shared/rubric/load.ts';
import { generateSyntheticPose } from './gen-synthetic-pose.ts';

export const PREPARE_BUDGET_MS = 300;
const WARMUP = 3;

/** The benchmark clip: bd.clear_fh, 60 Hz, 12 strokes over ≈ 30.5 s (the longest a user can submit). */
export function benchPose(): Record<string, unknown> {
  return generateSyntheticPose({ skill: 'bd.clear_fh', hz: 60, seed: 4242, strokes: 12, spacingS: 2.5 }).pose;
}

/** The payload as text, whitespace-padded to just under POSE_V1_MAX_BYTES (worst-case parse size). */
export function benchPayload(pose: Record<string, unknown>): string {
  let text = JSON.stringify(pose, null, 1);
  if (text.length > POSE_V1_MAX_BYTES - 1_000) text = JSON.stringify(pose);
  return text + ' '.repeat(Math.max(0, POSE_V1_MAX_BYTES - 1_000 - text.length));
}

export interface BenchResult {
  payloadBytes: number;
  frames: number;
  strokes: number;
  parseZodMs: { median: number; max: number };
  prepareMs: { median: number; max: number };
  stagesMs: Record<string, number>;
}

function stats(v: number[]): { median: number; max: number } {
  const a = [...v].sort((x, y) => x - y);
  const r = (x: number) => Math.round(x * 10) / 10;
  return { median: r(a[Math.floor(a.length / 2)]), max: r(a[a.length - 1]) };
}

export function runBench(runs = 10): BenchResult {
  const text = benchPayload(benchPose());
  const rubric = loadRubric('badminton');
  const parseT: number[] = [], prepT: number[] = [];
  const stageSum: Record<string, number> = {};
  let strokes = 0, frames = 0;
  for (let k = 0; k < WARMUP + runs; k++) {
    const t0 = performance.now();
    const pose = PoseV1.parse(JSON.parse(text));
    const t1 = performance.now();
    const timings: Record<string, number> = {};
    const out = prepare(pose, { rubric, timings });
    const t2 = performance.now();
    if (!out.ok) throw new Error(`bench clip rejected: ${out.code}`);
    strokes = out.response.strokes.length;
    frames = pose.track.tUs.length;
    if (k < WARMUP) continue;
    parseT.push(t1 - t0);
    prepT.push(t2 - t1);
    for (const [name, ms] of Object.entries(timings)) stageSum[name] = (stageSum[name] ?? 0) + ms;
  }
  const stagesMs = Object.fromEntries(Object.entries(stageSum).map(([k, v]) => [k, Math.round((v / runs) * 10) / 10]));
  return { payloadBytes: text.length, frames, strokes, parseZodMs: stats(parseT), prepareMs: stats(prepT), stagesMs };
}

if (import.meta.main) {
  const i = Deno.args.indexOf('--runs');
  const runs = i >= 0 ? Number(Deno.args[i + 1]) : 10;
  const r = runBench(runs);
  if (Deno.args.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(
      `clip: ${r.frames} frames at 60 Hz, ${r.strokes} strokes; payload ${(r.payloadBytes / 1e6).toFixed(2)} MB`,
    );
    console.log(`JSON.parse + PoseV1 (Zod): median ${r.parseZodMs.median} ms, max ${r.parseZodMs.max} ms`);
    for (const [k, v] of Object.entries(r.stagesMs)) console.log(`  ${k.padEnd(22)} ${v} ms (mean)`);
    console.log(`prepare (excl. parse):     median ${r.prepareMs.median} ms, max ${r.prepareMs.max} ms`);
    console.log(`budget ${PREPARE_BUDGET_MS} ms: ${r.prepareMs.median < PREPARE_BUDGET_MS ? 'PASS' : 'FAIL'}`);
  }
  Deno.exit(r.prepareMs.median < PREPARE_BUDGET_MS ? 0 : 1);
}
