/**
 * Grammar and prompt-cache warm-up (DESIGN.md §8.2 "Grammar warm-up"): one tiny call per model × sport with the real
 * system blocks and the real `coach.v1` schema, so the structured-output grammar is compiled and the rubric prefix is
 * cached before users arrive. `max_tokens: 0` cannot be combined with `output_config.format`, so a small cap is used
 * and `stop_reason: "max_tokens"` counts as success. Used by scripts/warm-schemas.ts and the cron `warm` task.
 */
import type { Sport } from '../contracts/common.ts';
import { supportsServerFallback, systemBlocks } from './build_request.ts';
import type { CoachRequestParams } from './client.ts';
import { runOnce, type RunOnceDeps, type RunResult } from './run_once.ts';
import { coachOutputSchema } from './schema_per_sport.ts';
import { FALLBACK_BETA, type ModelRoute } from './types.ts';

export const WARM_MAX_TOKENS = 64;
const WARM_USER_TEXT =
  'Warm-up request. No clip is attached: return the JSON object for an empty, not assessable clip.';

export function buildWarmRequest(route: ModelRoute, sport: Sport): CoachRequestParams {
  const params: CoachRequestParams = {
    model: route.model,
    max_tokens: WARM_MAX_TOKENS,
    system: systemBlocks(sport),
    messages: [{ role: 'user', content: [{ type: 'text', text: WARM_USER_TEXT }] }],
    // Same effort and schema as real traffic: both are part of the cached prefix / compiled grammar.
    output_config: { effort: route.effort, format: { type: 'json_schema', schema: coachOutputSchema(sport) } },
  };
  if (route.fallbacks === 'default' && supportsServerFallback(route.model)) {
    params.betas = [FALLBACK_BETA];
    params.fallbacks = 'default';
  }
  return params;
}

export interface WarmResult {
  model: string;
  sport: Sport;
  /** True when the schema was accepted (any 200 response: end_turn, max_tokens or a refusal). */
  ok: boolean;
  run: RunResult;
}

/** One warm-up call. A 400 (e.g. "Schema is too complex") is the failure this exists to catch. */
export async function warmOnce(route: ModelRoute, sport: Sport, deps: RunOnceDeps): Promise<WarmResult> {
  const run = await runOnce(buildWarmRequest(route, sport), route, deps);
  const k = run.outcome.kind;
  // A response arrived: the grammar compiled. parse_error is expected (the JSON is cut off at max_tokens).
  const ok = k === 'ok' || k === 'max_tokens' || k === 'parse_error' || k === 'refusal';
  return { model: route.model, sport, ok, run };
}
