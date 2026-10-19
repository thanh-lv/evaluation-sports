/**
 * LIVE smoke test of the Claude step (DESIGN.md §8.7 "M6 live smoke test"; needs the owner's approval, ≈ $0.50).
 * For every model × sport it runs the real request built from a synthetic fixture and reports:
 *   - schema compile: the coach.v1 schema is accepted (no 400 / "Schema is too complex");
 *   - real token counts (count_tokens for the whole request and for the cached system prefix);
 *   - a cache read on the 2nd identical call (usage.cache_read_input_tokens > 0);
 *   - stop_reason, refusal category, model served, latency, postprocess flags and the cost of every call.
 *
 *   ANTHROPIC_API_KEY=… deno run -A --config supabase/functions/deno.json scripts/smoke-claude.ts --yes-spend
 *        [--models haiku,sonnet] [--sports badminton,pickleball] [--lang vi|en] [--calls 2]
 *        [--effort low|medium|high] [--frames-dir <dir>] [--out <dir>]
 *
 * --frames-dir: real face-blurred JPEG frames, <dir>/<sport>/F1.jpg … F5.jpg (or <dir>/F1.jpg …). Without it the
 * request carries no images (as in pose_only); add ≈ 5 × 600 input tokens per call for the frames.
 * --effort overrides the route's effort (the M6 effort sweep). --out writes each composed result as JSON.
 * Refuses to run without --yes-spend. Never run in CI.
 */
import type { AnalysisKind, Language, Sport, UploadFrameId } from '@shared/contracts/index.ts';
import {
  anthropicCoachClient,
  buildCoachRequest,
  type CoachAttemptResult,
  DEFAULT_MODEL_ROUTES,
  type Effort,
  EFFORTS,
  type FrameImage,
  priceFor,
  runCoachAttempt,
  systemBlocks,
} from '@shared/claude/index.ts';
import { createLogger } from '@shared/log.ts';
import { loadRubric } from '@shared/rubric/load.ts';
import { prettyJson, repoPath } from './_lib/json.ts';
import { replayPrepare } from './replay.ts';

const FIXTURE: Readonly<Record<Sport, string>> = {
  badminton: 'synthetic_bd_clear_fh_60',
  pickleball: 'synthetic_pb_dink_60',
};
const MODEL_KIND: Readonly<Record<string, AnalysisKind>> = { haiku: 'basic', sonnet: 'standard' };
const VALUE_FLAGS = new Set(['--models', '--sports', '--lang', '--calls', '--effort', '--frames-dir', '--out']);

function arg(name: string): string | null {
  const i = Deno.args.indexOf(name);
  return i >= 0 && i + 1 < Deno.args.length ? Deno.args[i + 1] : null;
}

function listArg(name: string, all: readonly string[]): string[] {
  const raw = arg(name);
  if (!raw) return [...all];
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  for (const v of list) {
    if (!all.includes(v)) throw new Error(`${name}: unknown value ${v} (expected ${all.join('|')})`);
  }
  return list;
}

async function loadFrames(dir: string | null, sport: Sport, ids: readonly UploadFrameId[]): Promise<FrameImage[]> {
  if (!dir) return [];
  const out: FrameImage[] = [];
  for (const id of ids) {
    for (const path of [`${dir}/${sport}/${id}.jpg`, `${dir}/${id}.jpg`]) {
      try {
        const bytes = await Deno.readFile(path);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        out.push({ frameId: id, jpegBase64: btoa(bin) });
        break;
      } catch { /* try the next location */ }
    }
  }
  return out;
}

function usageLine(n: number, a: CoachAttemptResult): string {
  const c = a.run.call;
  const u = c.usage;
  return [
    `  call ${n}: ${a.run.outcome.kind.padEnd(11)} stop=${c.stopReason ?? '-'}`,
    `served=${c.modelServed ?? '-'}${c.fallbackUsed ? ' (fallback)' : ''}`,
    `in=${u.inputTokens} out=${u.outputTokens} cache_write=${u.cacheCreationInputTokens} cache_read=${u.cacheReadInputTokens}`,
    `$${c.costUsd.toFixed(5)} ${c.latencyMs} ms`,
    c.refusalCategory ? `refusal=${c.refusalCategory}` : '',
    a.post ? `flags=${a.post.flags.length}` : '',
  ].filter(Boolean).join(' · ');
}

async function main(): Promise<number> {
  if (!Deno.args.includes('--yes-spend')) {
    console.error('smoke-claude.ts calls the live Claude API (≈ $0.50 for the full matrix). Re-run with --yes-spend.');
    return 2;
  }
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set.');
    return 2;
  }
  const stray = Deno.args.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.has(Deno.args[i - 1])));
  if (stray.length) throw new Error(`unexpected arguments: ${stray.join(' ')}`);
  const models = listArg('--models', Object.keys(MODEL_KIND));
  const sports = listArg('--sports', ['badminton', 'pickleball']) as Sport[];
  const language = (arg('--lang') ?? 'vi') as Language;
  if (language !== 'vi' && language !== 'en') throw new Error('--lang must be vi or en');
  const calls = Math.max(1, Math.min(5, Number(arg('--calls') ?? 2)));
  const effort = arg('--effort') as Effort | null;
  if (effort && !(EFFORTS as readonly string[]).includes(effort)) throw new Error(`--effort: ${effort}`);
  const outDir = arg('--out');
  if (outDir) await Deno.mkdir(outDir, { recursive: true });

  const client = anthropicCoachClient({ apiKey });
  if (!client.countTokens) throw new Error('live client has no countTokens');
  const log = createLogger({ script: 'smoke-claude' }, { level: 'warn' });
  const failures: string[] = [];
  let total = 0;

  for (const m of models) {
    const kind = MODEL_KIND[m];
    const route = { ...DEFAULT_MODEL_ROUTES[kind], ...(effort ? { effort } : {}) };
    for (const sport of sports) {
      const label = `${route.model} × ${sport} (effort ${route.effort}, ${language})`;
      console.log(`\n== ${label}`);
      const pose = JSON.parse(await Deno.readTextFile(repoPath(`shared/fixtures/pose/${FIXTURE[sport]}.json`)));
      const { out } = replayPrepare(pose);
      if (!out.ok) throw new Error(`${FIXTURE[sport]}: prepare rejected ${out.code}`);
      const prepared = out.prepared;
      const rubric = loadRubric(sport);
      const uploadIds = prepared.frameRequests.filter((f) => f.upload).map((f) => f.frameId as UploadFrameId);
      const frames = await loadFrames(arg('--frames-dir'), sport, uploadIds);
      const input = { prepared, rubric, language, route, frames };
      const { params } = buildCoachRequest(input);

      // Real token counts: the whole request, and the cached system prefix alone.
      const counted = await client.countTokens({
        model: params.model,
        system: params.system,
        messages: params.messages,
        output_config: params.output_config,
      });
      const prefix = await client.countTokens({
        model: params.model,
        system: systemBlocks(sport),
        messages: [{ role: 'user', content: 'x' }],
      });
      const p = priceFor(route.model);
      const worst = calls * (counted * p.cacheWrite5m + params.max_tokens * p.output) / 1e6;
      console.log(
        `  input tokens ${counted} (system prefix ≈ ${prefix}), frames attached ${frames.length}, ` +
          `max_tokens ${params.max_tokens}; worst case for ${calls} calls ≈ $${worst.toFixed(3)}`,
      );

      let cacheRead = false;
      for (let n = 1; n <= calls; n++) {
        const a = await runCoachAttempt({
          ...input,
          kind,
          client,
          log,
          createdAt: new Date().toISOString(),
        });
        total += a.run.call.costUsd;
        console.log(usageLine(n, a));
        const kindOut = a.run.outcome.kind;
        if (kindOut === 'bad_request') failures.push(`${label}: schema/request rejected — ${a.run.call.error}`);
        else if (kindOut !== 'ok') failures.push(`${label} call ${n}: ${kindOut} ${a.run.call.error ?? ''}`);
        if (n >= 2 && a.run.call.usage.cacheReadInputTokens > 0) cacheRead = true;
        if (a.post?.flags.length) { for (const f of a.post.flags) console.log(`    flag ${f.type}: ${f.detail}`); }
        if (outDir && a.composed) {
          await Deno.writeTextFile(
            `${outDir}/${route.model}.${sport}.${language}.${n}.json`,
            prettyJson(a.composed.result),
          );
        }
        if (kindOut === 'bad_request') break;
      }
      if (calls >= 2 && !cacheRead) failures.push(`${label}: no cache read on the 2nd call`);
    }
  }

  console.log(`\ntotal cost: $${total.toFixed(4)}`);
  if (failures.length) {
    console.log('FAILED:');
    for (const f of failures) console.log(`  - ${f}`);
    return 1;
  }
  console.log('smoke-claude: OK');
  return 0;
}

if (import.meta.main) Deno.exit(await main());
