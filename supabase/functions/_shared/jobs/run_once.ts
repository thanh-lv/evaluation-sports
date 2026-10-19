/**
 * `runOnce(analysisId)`: one invocation of the analysis job (DESIGN.md D12, §8.3). Called from `/analyze/submit`
 * (waitUntil) and `/analyze/run` (pg_net dispatcher). Exactly one Claude attempt per invocation:
 *
 * 1. Load the analysis. A terminal job only gets its leftover frames removed (finalize normally does that).
 * 2. If `analysis_results` already exists (crash after the insert), claim and finalize with the stored result only.
 * 3. Claim with fencing (`claim_analysis` → attempt). No claim → another worker owns it, or it is not due.
 * 4. Load the prepared state, the route for `analyses.kind` and the frames (base64) → build the request → one call
 *    (CLAUDE_MODE=mock: the deterministic generator, no network) → classify → postprocess → compose.
 * 5. Write `private.llm_calls`, `daily_spend` / `user_monthly_cost` (and the 70 % alert) and `llm_outputs`.
 * 6. Apply the policy action with the fenced functions: finalize (then delete frames) / requeue / fail (refunds).
 *    A lost fence discards the output; its cost is already logged.
 */
import type { AnalysisKind, Language } from '@shared/contracts/index.ts';
import { PreparedAnalysisV1 } from '@shared/engine/index.ts';
import { loadRubric } from '@shared/rubric/load.ts';
import {
  buildCoachRequest,
  type CoachModelClient,
  type ComposeOutput,
  composeResult,
  type MockSource,
  postprocess,
  runOnce as runClaudeOnce,
  type RunOutcome,
} from '@shared/claude/index.ts';
import type { Db } from '../db.ts';
import { ConfigError } from '../errors.ts';
import { errorFields, type Logger } from '../log.ts';
import type { StorageService } from '../storage.ts';
import { loadBudgetStatus, maybeAlertDailySpend, operatorAlert } from '../budget.ts';
import { deleteFrames, expectedFrameIds, loadFrames } from './frames.ts';
import type { InFlightJobs } from './inflight.ts';
import { decideAction, JOB_LIMITS, type JobAction, type JobOutcomeKind } from './policy.ts';
import {
  claimAnalysis,
  countPriorParseErrors,
  failAnalysis,
  finalizeAnalysis,
  type JobAnalysisRow,
  loadJobAnalysis,
  loadModelRoute,
  loadStoredResult,
  PARSE_ERROR_PREFIX,
  recordLlmCall,
  recordLlmCost,
  requeueAnalysis,
  saveLlmOutput,
} from './store.ts';

export interface JobDeps {
  db: Db;
  storage: StorageService;
  /** The model client for one analysis (live SDK client, or the mock generator for this analysis). */
  coachClient: (src: MockSource) => CoachModelClient;
  log: Logger;
  now?: () => Date;
  inflight?: InFlightJobs;
  /** Extra cancellation for the model call (combined with the route timeout). */
  signal?: AbortSignal;
}

export type JobRunResult =
  | { status: 'not_found' }
  | { status: 'terminal'; state: string }
  | { status: 'not_claimed' }
  | { status: 'finalized'; attempt: number; resultStatus: 'succeeded' | 'rejected'; fromStored: boolean }
  | { status: 'requeued'; attempt: number; code: string; delayS: number }
  | { status: 'failed'; attempt: number; code: string }
  | { status: 'fence_lost'; attempt: number; action: JobAction['type'] };

const TERMINAL = new Set(['succeeded', 'rejected', 'failed']);

export async function runOnce(analysisId: string, deps: JobDeps): Promise<JobRunResult> {
  const log = deps.log.child({ analysisId });
  const row = await loadJobAnalysis(deps.db, analysisId);
  if (!row) return { status: 'not_found' };
  if (TERMINAL.has(row.status)) {
    if (row.status !== 'failed') await safeDeleteFrames(deps, row, log);
    return { status: 'terminal', state: row.status };
  }

  const stored = await loadStoredResult(deps.db, analysisId);
  const attempt = await claimAnalysis(deps.db, analysisId);
  if (attempt === null) return { status: 'not_claimed' };
  deps.inflight?.add(analysisId, attempt);
  try {
    if (stored) return await finalizeStored(deps, row, attempt, stored.result, stored.overall_score, log);
    if (attempt > JOB_LIMITS.hardMaxAttempts) {
      return await apply(deps, row, attempt, { type: 'fail', code: 'internal', alert: true }, null, log);
    }
    return await attemptOnce(deps, row, attempt, log);
  } catch (err) {
    // Our own I/O failed (DB, Storage). Requeue with backoff under the same ceiling; the lock TTL covers the rest.
    log.error('job attempt failed', { attempt, ...errorFields(err) });
    const action = decideAction('internal_error', { attempt, maxTokensMult: 1, priorParseErrors: 0 });
    try {
      return await apply(deps, row, attempt, action, null, log);
    } catch (err2) {
      log.error('job error handling failed', errorFields(err2));
      throw err2;
    }
  } finally {
    deps.inflight?.remove(analysisId, attempt);
  }
}

async function finalizeStored(
  deps: JobDeps,
  row: JobAnalysisRow,
  attempt: number,
  result: ComposeOutput['result'],
  overall: number | null,
  log: Logger,
): Promise<JobRunResult> {
  const ok = await finalizeAnalysis(deps.db, row.id, attempt, result, overall, result.meta?.model ?? null);
  if (!ok) return { status: 'fence_lost', attempt, action: 'finalize' };
  log.info('job finalized from stored result', { attempt });
  await safeDeleteFrames(deps, row, log);
  return { status: 'finalized', attempt, resultStatus: result.status, fromStored: true };
}

async function attemptOnce(deps: JobDeps, row: JobAnalysisRow, attempt: number, log: Logger): Promise<JobRunResult> {
  const parsed = PreparedAnalysisV1.safeParse(row.prepared);
  if (!parsed.success || parsed.data.analysisId !== row.id) {
    log.error('prepared state unreadable', { attempt });
    return apply(deps, row, attempt, { type: 'fail', code: 'internal', alert: true }, null, log);
  }
  const prepared = parsed.data;
  const kind: AnalysisKind = row.kind ?? 'basic';
  const language: Language = row.language;
  const rubric = loadRubric(prepared.sport);
  const route = await loadModelRoute(deps.db, kind);

  const frameIds = expectedFrameIds(prepared);
  const frames = await loadFrames(deps.storage, row.user_id, row.id, frameIds);
  if (frameIds.length > 0 && frames.length === 0) {
    log.error('frames missing at run time', { attempt, expected: frameIds.length });
    return apply(deps, row, attempt, { type: 'fail', code: 'internal', alert: false }, null, log);
  }
  if (frames.length < frameIds.length) log.warn('some frames missing', { expected: frameIds, sent: frames.length });

  const maxTokensMult = Number(row.max_tokens_mult) || 1;
  const request = buildCoachRequest({ prepared, rubric, language, route, frames, maxTokensMult });
  const ctx = { prepared, rubric, language, sentFrameIds: request.sentFrameIds };
  let client: CoachModelClient;
  try {
    client = deps.coachClient(ctx);
  } catch (err) {
    // No usable model client (live mode without a key): permanent until redeployed, so fail now (refund + alert).
    if (!(err instanceof ConfigError)) throw err;
    log.error('no model client', { attempt, ...errorFields(err) });
    return apply(deps, row, attempt, { type: 'fail', code: 'internal', alert: true }, null, log);
  }
  const run = await runClaudeOnce(request.params, route, { client, log, signal: deps.signal });

  let kindOut: JobOutcomeKind = run.outcome.kind;
  let errorText = run.call.error;
  let composed: ComposeOutput | null = null;
  if (run.outcome.kind === 'ok') {
    try {
      const post = postprocess(run.outcome.output, ctx);
      if (post.flags.length) log.info('claude_postprocess', { flags: post.flags.map((f) => `${f.type}: ${f.detail}`) });
      composed = composeResult({
        ...ctx,
        post,
        kind,
        model: run.call.modelServed ?? route.model,
        createdAt: (deps.now?.() ?? new Date()).toISOString(),
      });
    } catch (err) {
      kindOut = 'parse_error';
      errorText = `compose: ${(err as Error).message ?? String(err)}`;
      log.warn('compose failed', errorFields(err));
    }
  }
  if (kindOut === 'parse_error') errorText = `${PARSE_ERROR_PREFIX}: ${errorText ?? ''}`;

  await accountCall(deps, row, attempt, kind, run.call, errorText, run.outcome, log);

  const action = decideAction(kindOut, {
    attempt,
    maxTokensMult,
    priorParseErrors: kindOut === 'parse_error' ? await countPriorParseErrors(deps.db, row.id, attempt) : 0,
    retryReason: run.outcome.kind === 'retryable' ? run.outcome.reason : undefined,
  });
  return apply(deps, row, attempt, action, composed, log);
}

/** llm_calls + spend + raw output. Accounting failures are logged, never fatal: the outcome still gets applied. */
async function accountCall(
  deps: JobDeps,
  row: JobAnalysisRow,
  attempt: number,
  kind: AnalysisKind,
  call: Parameters<typeof recordLlmCall>[1]['call'],
  errorText: string | null,
  outcome: RunOutcome,
  log: Logger,
): Promise<void> {
  try {
    await recordLlmCall(deps.db, { analysisId: row.id, attempt, kind, call, error: errorText });
  } catch (err) {
    log.error('llm_calls insert failed', errorFields(err));
  }
  try {
    // every attempt counts in daily_spend.calls, even at $0 (mock mode, errors before a response)
    await recordLlmCost(deps.db, row.user_id, call.costUsd);
    if (call.costUsd > 0) await maybeAlertDailySpend(deps.db, await loadBudgetStatus(deps.db), log);
  } catch (err) {
    log.error('spend accounting failed', errorFields(err));
  }
  const output = outcome.kind === 'ok' ? outcome.raw : outcome.kind === 'parse_error' ? { text: outcome.text } : null;
  if (output !== null) {
    try {
      await saveLlmOutput(deps.db, row.id, attempt, output);
    } catch (err) {
      log.warn('llm_outputs insert failed', errorFields(err));
    }
  }
}

async function apply(
  deps: JobDeps,
  row: JobAnalysisRow,
  attempt: number,
  action: JobAction,
  composed: ComposeOutput | null,
  log: Logger,
): Promise<JobRunResult> {
  switch (action.type) {
    case 'finalize': {
      const result = composed!.result;
      const ok = await finalizeAnalysis(
        deps.db,
        row.id,
        attempt,
        result,
        composed!.scores?.overall.score ?? null,
        result.meta.model,
      );
      if (!ok) {
        log.warn('fence lost: output discarded', { attempt });
        return { status: 'fence_lost', attempt, action: 'finalize' };
      }
      await safeDeleteFrames(deps, row, log);
      log.info('job finalized', { attempt, resultStatus: result.status });
      return { status: 'finalized', attempt, resultStatus: result.status, fromStored: false };
    }
    case 'requeue': {
      const ok = await requeueAnalysis(deps.db, row.id, attempt, action.delayS, action.code, action.maxTokensMult);
      if (!ok) return { status: 'fence_lost', attempt, action: 'requeue' };
      log.info('job requeued', { attempt, code: action.code, delayS: action.delayS });
      return { status: 'requeued', attempt, code: action.code, delayS: action.delayS };
    }
    case 'fail': {
      const ok = await failAnalysis(deps.db, row.id, attempt, action.code);
      if (!ok) return { status: 'fence_lost', attempt, action: 'fail' };
      log.warn('job failed', { attempt, code: action.code });
      if (action.alert) {
        await operatorAlert(deps.db, log, 'job_failed', { analysisId: row.id, attempt, code: action.code });
      }
      return { status: 'failed', attempt, code: action.code };
    }
  }
}

async function safeDeleteFrames(deps: JobDeps, row: JobAnalysisRow, log: Logger): Promise<void> {
  if (row.frame_mode === 'pose_only') return;
  try {
    await deleteFrames(deps.storage, row.user_id, row.id);
  } catch (err) {
    // the daily cron's walk removes leftovers
    log.warn('frame deletion failed', errorFields(err));
  }
}
