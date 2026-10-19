/**
 * LIVE (spends a little money): warms the structured-output grammar and the rubric prompt cache for every model ×
 * sport after a deploy (DESIGN.md §8.2 "Grammar warm-up"). One `max_tokens: 64` call per pair with the real system
 * blocks and coach.v1 schema; `stop_reason: max_tokens` counts as success, a 400 (e.g. "Schema is too complex") fails.
 *
 *   ANTHROPIC_API_KEY=… deno run -A --config supabase/functions/deno.json scripts/warm-schemas.ts --yes-spend
 *        [--kinds basic,standard] [--sports badminton,pickleball] [--dry-run]
 *
 * Routes are the `model_routes` seed (DEFAULT_MODEL_ROUTES). `--dry-run` prints the requests (schema elided) and
 * makes no call. Expected cost: about $0.05 cold for all four pairs (mostly Sonnet cache writes of the ≈ 9K-token
 * system prefix).
 */
import type { AnalysisKind, Sport } from '@shared/contracts/index.ts';
import {
  anthropicCoachClient,
  buildWarmRequest,
  DEFAULT_MODEL_ROUTES,
  type ModelRoute,
  warmOnce,
} from '@shared/claude/index.ts';
import { createLogger } from '@shared/log.ts';

function listArg(name: string, all: readonly string[]): string[] {
  const i = Deno.args.indexOf(name);
  if (i < 0 || i + 1 >= Deno.args.length) return [...all];
  const list = Deno.args[i + 1].split(',').map((s) => s.trim()).filter(Boolean);
  for (const v of list) {
    if (!all.includes(v)) throw new Error(`${name}: unknown value ${v} (expected ${all.join('|')})`);
  }
  return list;
}

async function main(): Promise<number> {
  const kinds = listArg('--kinds', ['basic', 'standard']) as AnalysisKind[];
  const sports = listArg('--sports', ['badminton', 'pickleball']) as Sport[];
  const routes: ModelRoute[] = kinds.map((k) => DEFAULT_MODEL_ROUTES[k]);

  if (Deno.args.includes('--dry-run')) {
    for (const route of routes) {
      for (const sport of sports) {
        const req = buildWarmRequest(route, sport);
        console.log(
          JSON.stringify(
            req,
            (k, v) => (k === 'schema' ? '<coach.v1 schema>' : k === 'text' ? `<${String(v).length} chars>` : v),
          ),
        );
      }
    }
    return 0;
  }
  if (!Deno.args.includes('--yes-spend')) {
    console.error('warm-schemas.ts calls the live Claude API (a few cents). Re-run with --yes-spend, or --dry-run.');
    return 2;
  }
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set.');
    return 2;
  }
  const client = anthropicCoachClient({ apiKey });
  const log = createLogger({ script: 'warm-schemas' }, { level: 'warn' });
  let failed = 0;
  let total = 0;
  console.log('model                sport       outcome      stop        cache_write cache_read  cost_usd  ms');
  for (const route of routes) {
    for (const sport of sports) {
      const w = await warmOnce(route, sport, { client, log });
      const c = w.run.call;
      total += c.costUsd;
      if (!w.ok) failed++;
      console.log(
        [
          route.model.padEnd(20),
          sport.padEnd(11),
          (w.ok ? w.run.outcome.kind : `FAIL ${w.run.outcome.kind}`).padEnd(12),
          String(c.stopReason ?? '-').padEnd(11),
          String(c.usage.cacheCreationInputTokens).padStart(11),
          String(c.usage.cacheReadInputTokens).padStart(10),
          c.costUsd.toFixed(6).padStart(9),
          String(c.latencyMs).padStart(6),
        ].join(' '),
      );
      if (!w.ok) console.error(`  ${c.error}`);
    }
  }
  console.log(`total cost: $${total.toFixed(4)}`);
  return failed ? 1 : 0;
}

if (import.meta.main) Deno.exit(await main());
