/**
 * Public API of the Claude module (DESIGN.md §8). Typical use in the analyze job:
 *
 *   const attempt = await runCoachAttempt({
 *     prepared, rubric, language, route, frames, maxTokensMult, kind, createdAt, log,
 *     client: (req) => coachClientForMode(env.claudeMode, env.anthropicApiKey,
 *                                         { prepared, rubric, language, sentFrameIds: req.sentFrameIds }),
 *   });
 *   // attempt.run.call → private.llm_calls (every attempt); attempt.run.outcome → finalize / requeue / fail (§8.3);
 *   // attempt.composed.result (outcome ok) → finalize_analysis; attempt.post.flags → logs.
 * The steps (buildCoachRequest, runOnce, postprocess, composeResult) are exported for finer control.
 */
import type { ClaudeMode } from '../env.ts';
import { anthropicCoachClient, type CoachModelClient } from './client.ts';
import { mockCoachClient, type MockSource } from './mock.ts';

export * from './types.ts';
export * from './pricing.ts';
export * from './client.ts';
export * from './schema_per_sport.ts';
export * from './build_request.ts';
export * from './run_once.ts';
export * from './postprocess.ts';
export * from './compose.ts';
export * from './medical_filter.ts';
export * from './mock.ts';
export * from './pipeline.ts';
export * from './warm.ts';
export { fakeMessage, type FakeMessageOptions } from './fake_message.ts';
export { BASE_SYSTEM_V2 } from './prompts/base_system.ts';
export { renderRubricText, rubricText } from './prompts/rubric_text.ts';
export { buildUserText } from './prompts/user_text.ts';

/** `live` → the Anthropic SDK client; `mock` → the deterministic generator for this analysis. */
export function coachClientForMode(mode: ClaudeMode, apiKey: string | null, mock: MockSource): CoachModelClient {
  if (mode === 'live') {
    if (!apiKey) throw new Error('CLAUDE_MODE=live needs ANTHROPIC_API_KEY');
    return anthropicCoachClient({ apiKey });
  }
  return mockCoachClient(mock);
}
