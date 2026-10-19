/**
 * Outcome → job action (DESIGN.md §8.3, D12). Pure; `run_once.ts` applies the action with the fenced SQL functions.
 *
 * | Outcome                         | Action                                                                     |
 * |---------------------------------|----------------------------------------------------------------------------|
 * | ok                              | finalize                                                                   |
 * | refusal                         | fail model_refusal (full refund)                                           |
 * | max_tokens                      | requeue with max_tokens_mult 1.5, once; again → fail bad_output            |
 * | parse_error (JSON, Zod, compose)| requeue once; again → fail bad_output                                      |
 * | retryable (429/529/5xx/timeout) | requeue after 30 s·2^attempt; at attempt 3 → fail upstream_unavailable      |
 * | bad_request (400)               | fail bad_request + operator alert                                          |
 * | internal_error (our own I/O)    | requeue with the same backoff; at attempt 3 → fail internal + alert         |
 *
 * The SQL functions do not cap retries (claim_analysis just increments attempt_count), so the ceiling lives here:
 * `attempt` counts every claim, including max_tokens/parse requeues and stale re-claims after a crash, and a claim
 * past `hardMaxAttempts` fails without calling the model.
 */
import type { FailureCode } from '@shared/contracts/index.ts';
import type { RunOutcome } from '@shared/claude/index.ts';

export const JOB_LIMITS = {
  /** Retryable failures are requeued while attempt < maxAttempts. */
  maxAttempts: 3,
  /** A claim with a higher attempt number fails immediately (crash loops, endless stale re-claims). */
  hardMaxAttempts: 6,
  backoffBaseS: 30,
  maxTokensMult: 1.5,
  /** pollAfterMs returned by submit. */
  pollAfterMs: 2000,
} as const;

export type JobOutcomeKind = RunOutcome['kind'] | 'internal_error';

export type JobAction =
  | { type: 'finalize' }
  | { type: 'requeue'; delayS: number; code: string; maxTokensMult?: number }
  | { type: 'fail'; code: FailureCode; alert: boolean };

export interface DecisionContext {
  /** Attempt number returned by claim_analysis. */
  attempt: number;
  /** `analyses.max_tokens_mult` before this attempt. */
  maxTokensMult: number;
  /** Earlier attempts of this analysis that ended in a parse error. */
  priorParseErrors: number;
  /** For retryable outcomes: the reason (rate_limited, overloaded, …), used in last_error_code. */
  retryReason?: string;
}

/** 30 s · 2^attempt (attempt 1 → 60 s, attempt 2 → 120 s). */
export function backoffSeconds(attempt: number): number {
  return JOB_LIMITS.backoffBaseS * 2 ** Math.max(0, attempt);
}

export function decideAction(kind: JobOutcomeKind, ctx: DecisionContext): JobAction {
  switch (kind) {
    case 'ok':
      return { type: 'finalize' };
    case 'refusal':
      return { type: 'fail', code: 'model_refusal', alert: false };
    case 'bad_request':
      return { type: 'fail', code: 'bad_request', alert: true };
    case 'max_tokens':
      return ctx.maxTokensMult > 1
        ? { type: 'fail', code: 'bad_output', alert: false }
        : { type: 'requeue', delayS: 0, code: 'max_tokens', maxTokensMult: JOB_LIMITS.maxTokensMult };
    case 'parse_error':
      return ctx.priorParseErrors > 0
        ? { type: 'fail', code: 'bad_output', alert: false }
        : { type: 'requeue', delayS: 0, code: 'parse_error' };
    case 'retryable':
      return ctx.attempt >= JOB_LIMITS.maxAttempts
        ? { type: 'fail', code: 'upstream_unavailable', alert: false }
        : { type: 'requeue', delayS: backoffSeconds(ctx.attempt), code: `retry_${ctx.retryReason ?? 'upstream'}` };
    case 'internal_error':
      return ctx.attempt >= JOB_LIMITS.maxAttempts
        ? { type: 'fail', code: 'internal', alert: true }
        : { type: 'requeue', delayS: backoffSeconds(ctx.attempt), code: 'internal_error' };
  }
}
