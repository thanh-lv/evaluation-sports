/**
 * One full Claude attempt without DB access: build_request → runOnce → (ok) postprocess → compose. The analyze job,
 * the replay tool and the e2e tests share it; the job maps `run.outcome` to finalize / requeue / fail (§8.3).
 */
import type { AnalysisKind } from '../contracts/common.ts';
import type { Logger } from '../log.ts';
import { type BuiltCoachRequest, buildCoachRequest, type CoachRequestInput } from './build_request.ts';
import type { CoachModelClient } from './client.ts';
import { composeResult, type ComposeOutput } from './compose.ts';
import { postprocess, type PostprocessResult } from './postprocess.ts';
import { runOnce, type RunResult } from './run_once.ts';

export interface CoachAttemptInput extends CoachRequestInput {
  kind: AnalysisKind;
  /** A client, or a factory called with the built request (the mock client needs the frames actually sent). */
  client: CoachModelClient | ((request: BuiltCoachRequest) => CoachModelClient);
  /** ISO 8601 UTC timestamp stored as the result's createdAt. */
  createdAt: string;
  log?: Logger;
  now?: () => number;
  signal?: AbortSignal;
}

export interface CoachAttemptResult {
  request: BuiltCoachRequest;
  run: RunResult;
  /** Set when the outcome is ok. */
  post: PostprocessResult | null;
  /** Set when the outcome is ok. */
  composed: ComposeOutput | null;
}

export async function runCoachAttempt(input: CoachAttemptInput): Promise<CoachAttemptResult> {
  const request = buildCoachRequest(input);
  const client = typeof input.client === 'function' ? input.client(request) : input.client;
  const run = await runOnce(request.params, input.route, {
    client,
    log: input.log,
    now: input.now,
    signal: input.signal,
  });
  if (run.outcome.kind !== 'ok') return { request, run, post: null, composed: null };
  const ctx = {
    prepared: input.prepared,
    rubric: input.rubric,
    language: input.language,
    sentFrameIds: request.sentFrameIds,
  };
  const post = postprocess(run.outcome.output, ctx);
  if (post.flags.length) input.log?.info('claude_postprocess', { flags: post.flags.map((f) => `${f.type}: ${f.detail}`) });
  const composed = composeResult({
    ...ctx,
    post,
    kind: input.kind,
    model: run.call.modelServed ?? input.route.model,
    createdAt: input.createdAt,
  });
  return { request, run, post, composed };
}
