/**
 * Database access of the analysis job (DESIGN.md §6.5 job functions, §8.3 cost accounting), over the injected `Db`.
 * The fenced SQL functions (claim/finalize/requeue/fail) are the only writers of the job state.
 */
import type { AnalysisKind, CoachResultV1, Language } from '@shared/contracts/index.ts';
import {
  type CallRecord,
  DEFAULT_MODEL_ROUTES,
  type ModelRoute,
  modelRouteFromRow,
  type ModelRouteRow,
} from '@shared/claude/index.ts';
import type { Db } from '../db.ts';

export interface JobAnalysisRow {
  id: string;
  user_id: string;
  status: string;
  sport: 'badminton' | 'pickleball';
  skill: string;
  language: Language;
  frame_mode: 'frames' | 'pose_only';
  kind: AnalysisKind | null;
  attempt_count: number;
  max_tokens_mult: number;
  prepared: unknown;
}

const JOB_COLUMNS = 'id, user_id, status, sport, skill, language, frame_mode, kind, attempt_count, max_tokens_mult, ' +
  'prepared';

export function loadJobAnalysis(db: Db, id: string): Promise<JobAnalysisRow | null> {
  return db.selectOne<JobAnalysisRow>('public', 'analyses', JOB_COLUMNS, { id });
}

export interface StoredResultRow {
  result: CoachResultV1;
  overall_score: number | null;
}

export function loadStoredResult(db: Db, id: string): Promise<StoredResultRow | null> {
  return db.selectOne<StoredResultRow>('public', 'analysis_results', 'result, overall_score', { analysis_id: id });
}

/** New attempt number, or null when another worker owns the job or it is not due. */
export async function claimAnalysis(db: Db, id: string): Promise<number | null> {
  const attempt = await db.rpc<number | null>('private', 'claim_analysis', { p_analysis_id: id });
  return typeof attempt === 'number' ? attempt : null;
}

export async function finalizeAnalysis(
  db: Db,
  id: string,
  attempt: number,
  result: CoachResultV1,
  overallScore: number | null,
  model: string | null,
): Promise<boolean> {
  return (await db.rpc<boolean>('private', 'finalize_analysis', {
    p_analysis_id: id,
    p_attempt: attempt,
    p_result: result,
    p_overall_score: overallScore,
    p_model: model,
  })) === true;
}

export async function requeueAnalysis(
  db: Db,
  id: string,
  attempt: number,
  delayS: number,
  code: string,
  maxTokensMult?: number,
): Promise<boolean> {
  return (await db.rpc<boolean>('private', 'requeue_analysis', {
    p_analysis_id: id,
    p_attempt: attempt,
    p_delay_s: Math.round(delayS),
    p_code: code,
    p_max_tokens_mult: maxTokensMult ?? null,
  })) === true;
}

export async function failAnalysis(db: Db, id: string, attempt: number, code: string): Promise<boolean> {
  return (await db.rpc<boolean>('private', 'fail_analysis', {
    p_analysis_id: id,
    p_attempt: attempt,
    p_code: code,
  })) === true;
}

/** The `model_routes` row for a kind, or the seed default when the row is missing or malformed. */
export async function loadModelRoute(db: Db, kind: AnalysisKind): Promise<ModelRoute> {
  const row = await db.selectOne<ModelRouteRow>(
    'public',
    'model_routes',
    'kind, model, effort, max_tokens, timeout_ms, fallbacks, betas',
    { kind },
  );
  if (!row) return DEFAULT_MODEL_ROUTES[kind];
  try {
    return modelRouteFromRow(row);
  } catch {
    return DEFAULT_MODEL_ROUTES[kind];
  }
}

export async function loadAllModelRoutes(db: Db): Promise<ModelRoute[]> {
  return [await loadModelRoute(db, 'basic'), await loadModelRoute(db, 'standard')];
}

/** Prefix of `llm_calls.error` for parse failures (JSON, schema or compose), counted for the "requeue once" rule. */
export const PARSE_ERROR_PREFIX = 'parse_error';

/** One `private.llm_calls` row per attempt (§8.3), whatever the outcome. */
export async function recordLlmCall(
  db: Db,
  row: { analysisId: string; attempt: number; kind: AnalysisKind | null; call: CallRecord; error: string | null },
): Promise<void> {
  const { call } = row;
  await db.insert('private', 'llm_calls', {
    analysis_id: row.analysisId,
    attempt: row.attempt,
    kind: row.kind,
    model_requested: call.modelRequested,
    model_served: call.modelServed,
    effort: call.effort,
    stop_reason: call.stopReason,
    refusal_category: call.refusalCategory,
    input_tokens: call.usage.inputTokens,
    output_tokens: call.usage.outputTokens,
    cache_read_input_tokens: call.usage.cacheReadInputTokens,
    cache_creation_input_tokens: call.usage.cacheCreationInputTokens,
    cost_usd: Number(call.costUsd.toFixed(6)),
    latency_ms: call.latencyMs,
    request_id: call.requestId,
    error: row.error === null ? null : row.error.slice(0, 1000),
  });
}

export async function countPriorParseErrors(db: Db, analysisId: string, beforeAttempt: number): Promise<number> {
  const rows = await db.selectMany<{ attempt: number; error: string | null }>(
    'private',
    'llm_calls',
    'attempt, error',
    { analysis_id: analysisId },
  );
  return rows.filter((r) => r.attempt < beforeAttempt && r.error?.startsWith(PARSE_ERROR_PREFIX)).length;
}

/** Adds the attempt's cost to `daily_spend` and `user_monthly_cost`; returns the new day total. */
export async function recordLlmCost(db: Db, userId: string | null, costUsd: number): Promise<number | null> {
  const r = await db.rpc<{ dayUsd?: unknown } | null>('private', 'record_llm_cost', {
    p_user_id: userId,
    p_cost_usd: Number(costUsd.toFixed(6)),
  });
  const day = Number(r?.dayUsd);
  return Number.isFinite(day) ? day : null;
}

/** Raw model output for debugging/evals (90-day retention). */
export async function saveLlmOutput(db: Db, analysisId: string, attempt: number, output: unknown): Promise<void> {
  await db.insert('private', 'llm_outputs', { analysis_id: analysisId, attempt, output });
}
