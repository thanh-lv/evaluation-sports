/**
 * One Claude attempt → a classified outcome (DESIGN.md §8.3). No DB access: the caller maps the outcome to
 * finalize / requeue / fail and writes `private.llm_calls` from `call` (one row per attempt, every outcome).
 *
 *   ok           parsed coach.v1 output (lenient Zod)          → postprocess, finalize
 *   refusal      stop_reason "refusal" (stop_details.category)  → fail model_refusal, full refund
 *   max_tokens   stop_reason "max_tokens"                       → requeue with max_tokens_mult 1.5 (once)
 *   parse_error  no text / invalid JSON / Zod failure           → requeue once, then fail bad_output
 *   retryable    429 / 529 / 5xx / 408 / 409 / timeout / network → requeue with backoff (3 attempts)
 *   bad_request  400 and other 4xx, client-side SDK errors      → fail bad_request + operator alert
 */
import {
  AnthropicError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk';
import { CoachOutputV1 } from '../contracts/coach_output.ts';
import type { CoachMessage, CoachModelClient, CoachRequestParams } from './client.ts';
import { requestIdOf } from './client.ts';
import { costUsd } from './pricing.ts';
import type { Logger } from '../log.ts';
import { type ModelRoute, type UsageMeters, ZERO_USAGE } from './types.ts';

export type RetryReason = 'rate_limited' | 'overloaded' | 'server_error' | 'timeout' | 'network';

export type RunOutcome =
  | { kind: 'ok'; output: CoachOutputV1; raw: unknown }
  | { kind: 'refusal'; category: string | null; explanation: string | null }
  | { kind: 'max_tokens' }
  | { kind: 'parse_error'; error: string; text: string }
  | { kind: 'retryable'; reason: RetryReason; status: number | null; message: string }
  | { kind: 'bad_request'; status: number | null; message: string };

/** Everything `private.llm_calls` needs for this attempt (camel-cased columns). */
export interface CallRecord {
  modelRequested: string;
  /** `response.model` (differs after a server-side fallback); null when no response arrived. */
  modelServed: string | null;
  effort: string;
  stopReason: string | null;
  refusalCategory: string | null;
  usage: UsageMeters;
  costUsd: number;
  latencyMs: number;
  requestId: string | null;
  /** True when a server-side fallback model produced (part of) the response. */
  fallbackUsed: boolean;
  error: string | null;
}

export interface RunResult {
  outcome: RunOutcome;
  call: CallRecord;
}

export interface RunOnceDeps {
  client: CoachModelClient;
  /** Monotonic-ish clock in ms (injected for tests). */
  now?: () => number;
  signal?: AbortSignal;
  /** When set, one `claude_call` line with usage (incl. cache reads), cost and outcome is logged per attempt. */
  log?: Logger;
}

export function usageOf(message: CoachMessage): UsageMeters {
  const u = message.usage;
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
    cacheCreation1hInputTokens: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
  };
}

function fallbackUsed(message: CoachMessage): boolean {
  const iterations = (message.usage.iterations ?? []) as { type?: string }[];
  return iterations.some((i) => i.type === 'fallback_message') ||
    message.content.some((b) => (b as { type: string }).type === 'fallback');
}

/**
 * Concatenated `text` blocks after the last `fallback` block (thinking blocks are skipped: blocks are read by type).
 * A non-streaming mid-output decline omits the declined partial, but if one is ever present it must not be glued in
 * front of the fallback model's JSON.
 */
export function responseText(message: CoachMessage): string {
  const blocks = message.content as { type: string; text?: string }[];
  let start = 0;
  blocks.forEach((b, i) => {
    if (b.type === 'fallback') start = i + 1;
  });
  return blocks.slice(start).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
}

interface IterationLike {
  type?: string;
  model?: string | null;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_1h_input_tokens?: number } | null;
}

/**
 * Billed cost of a response. Top-level `usage` covers only the attempt that produced the message; after a server-side
 * fallback, `usage.iterations` lists every attempt (the declined one included) with its own model, and is the billing
 * source of truth. Summing it errs on the safe side for the budget guard.
 */
export function billedCostUsd(message: CoachMessage, requestedModel: string): number {
  const iterations = ((message.usage.iterations ?? []) as IterationLike[]).filter((i) =>
    i.type === 'message' || i.type === 'fallback_message'
  );
  if (iterations.length < 2) return costUsd(message.model ?? requestedModel, usageOf(message));
  let usd = 0;
  for (const i of iterations) {
    usd += costUsd(i.model ?? (i.type === 'message' ? requestedModel : message.model), {
      inputTokens: i.input_tokens ?? 0,
      outputTokens: i.output_tokens ?? 0,
      cacheReadInputTokens: i.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: i.cache_creation_input_tokens ?? 0,
      cacheCreation1hInputTokens: i.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    });
  }
  return Math.round(usd * 1e6) / 1e6;
}

/** Pure classification of a response that arrived (HTTP 200). */
export function classifyMessage(message: CoachMessage): RunOutcome {
  if (message.stop_reason === 'refusal') {
    return {
      kind: 'refusal',
      category: message.stop_details?.category ?? null,
      explanation: message.stop_details?.explanation ?? null,
    };
  }
  if (message.stop_reason === 'max_tokens') return { kind: 'max_tokens' };
  if (message.stop_reason === 'model_context_window_exceeded') {
    return { kind: 'bad_request', status: null, message: 'model_context_window_exceeded' };
  }
  const text = responseText(message);
  if (message.stop_reason !== 'end_turn' && message.stop_reason !== 'stop_sequence') {
    return { kind: 'parse_error', error: `unexpected stop_reason ${message.stop_reason}`, text };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { kind: 'parse_error', error: `invalid JSON: ${(e as Error).message}`, text };
  }
  const parsed = CoachOutputV1.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return { kind: 'parse_error', error: `schema: ${issues}`, text };
  }
  return { kind: 'ok', output: parsed.data, raw };
}

/** Pure classification of a thrown error (no response). */
export function classifyError(err: unknown): Extract<RunOutcome, { kind: 'retryable' | 'bad_request' }> {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof APIConnectionTimeoutError || err instanceof APIUserAbortError) {
    return { kind: 'retryable', reason: 'timeout', status: null, message };
  }
  if (err instanceof APIConnectionError) return { kind: 'retryable', reason: 'network', status: null, message };
  if (err instanceof APIError) {
    const status = typeof err.status === 'number' ? err.status : null;
    if (status === 429) return { kind: 'retryable', reason: 'rate_limited', status, message };
    if (status === 529) return { kind: 'retryable', reason: 'overloaded', status, message };
    if (status === 408) return { kind: 'retryable', reason: 'timeout', status, message };
    if (status === 409 || (status !== null && status >= 500)) {
      return { kind: 'retryable', reason: 'server_error', status, message };
    }
    if (status === null) return { kind: 'retryable', reason: 'network', status, message };
    return { kind: 'bad_request', status, message };
  }
  if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return { kind: 'retryable', reason: 'timeout', status: null, message };
  }
  // Client-side SDK validation errors will fail the same way every time.
  if (err instanceof AnthropicError) return { kind: 'bad_request', status: null, message };
  // Anything else (fetch TypeError, DNS, …) is treated as a transient network failure.
  return { kind: 'retryable', reason: 'network', status: null, message };
}

function errorText(o: RunOutcome): string | null {
  switch (o.kind) {
    case 'ok':
    case 'max_tokens':
      return null;
    case 'refusal':
      return `refusal${o.category ? `:${o.category}` : ''}`;
    case 'parse_error':
      return o.error.slice(0, 500);
    case 'retryable':
      return `${o.reason}${o.status ? ` ${o.status}` : ''}: ${o.message}`.slice(0, 500);
    case 'bad_request':
      return `bad_request${o.status ? ` ${o.status}` : ''}: ${o.message}`.slice(0, 500);
  }
}

/** Runs exactly one attempt (no retries: `maxRetries: 0` in the client, the job runner owns retries). */
export async function runOnce(params: CoachRequestParams, route: ModelRoute, deps: RunOnceDeps): Promise<RunResult> {
  const now = deps.now ?? (() => performance.now());
  const t0 = now();
  let message: CoachMessage | null = null;
  let outcome: RunOutcome;
  let errorRequestId: string | null = null;
  try {
    message = await deps.client.create(params, { timeoutMs: route.timeoutMs, signal: deps.signal });
    outcome = classifyMessage(message);
  } catch (err) {
    outcome = classifyError(err);
    if (err instanceof APIError && typeof err.requestID === 'string') errorRequestId = err.requestID;
  }
  const latencyMs = Math.max(0, Math.round(now() - t0));
  const usage = message ? usageOf(message) : { ...ZERO_USAGE };
  const served = message?.model ?? null;
  const result: RunResult = {
    outcome,
    call: {
      modelRequested: params.model,
      modelServed: served,
      effort: params.output_config?.effort ?? route.effort,
      stopReason: message?.stop_reason ?? null,
      refusalCategory: outcome.kind === 'refusal' ? outcome.category : null,
      usage,
      costUsd: message ? billedCostUsd(message, params.model) : 0,
      latencyMs,
      requestId: message ? requestIdOf(message) : errorRequestId,
      fallbackUsed: message ? fallbackUsed(message) : false,
      error: errorText(outcome),
    },
  };
  deps.log?.info('claude_call', { outcome: outcome.kind, client: deps.client.name, ...result.call });
  return result;
}
