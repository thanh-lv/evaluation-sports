/**
 * Shared types of the Claude module (DESIGN.md §8). Nothing here does I/O.
 */
import type { AnalysisKind, UploadFrameId } from '../contracts/common.ts';

/** Stored in `coach-result.v1` meta.promptVersion; bump whenever BASE_SYSTEM_V2, RUBRIC_TEXT or userText change shape. */
export const PROMPT_VERSION = 'coach-prompt-2.0';

/** The beta that gates `fallbacks: "default"` (Claude API only, never on Haiku 5.5). */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

/** One `public.model_routes` row (DESIGN.md §8.1), camel-cased. */
export interface ModelRoute {
  kind: AnalysisKind;
  model: string;
  effort: Effort;
  maxTokens: number;
  timeoutMs: number;
  /** `"default"` = server-side fallback (Sonnet on the Claude API only); null = none. */
  fallbacks: 'default' | null;
  betas: string[];
}

/** Shape of a `public.model_routes` row as PostgREST returns it. */
export interface ModelRouteRow {
  kind: string;
  model: string;
  effort: string;
  max_tokens: number;
  timeout_ms: number;
  fallbacks: string | null;
  betas: string[] | null;
}

export function modelRouteFromRow(row: ModelRouteRow): ModelRoute {
  if (row.kind !== 'basic' && row.kind !== 'standard') throw new Error(`model_routes: bad kind ${row.kind}`);
  if (!(EFFORTS as readonly string[]).includes(row.effort)) throw new Error(`model_routes: bad effort ${row.effort}`);
  if (row.fallbacks !== null && row.fallbacks !== 'default') throw new Error(`model_routes: bad fallbacks`);
  return {
    kind: row.kind,
    model: row.model,
    effort: row.effort as Effort,
    maxTokens: row.max_tokens,
    timeoutMs: row.timeout_ms,
    fallbacks: row.fallbacks,
    betas: [...(row.betas ?? [])],
  };
}

/** Mirrors the `model_routes` seed (supabase/seed.sql); used by scripts and as a fallback when the row is missing. */
export const DEFAULT_MODEL_ROUTES: Readonly<Record<AnalysisKind, ModelRoute>> = {
  basic: {
    kind: 'basic',
    model: 'claude-haiku-5-5',
    effort: 'medium',
    maxTokens: 12000,
    timeoutMs: 90000,
    fallbacks: null,
    betas: [],
  },
  standard: {
    kind: 'standard',
    model: 'claude-sonnet-5-5',
    effort: 'low',
    maxTokens: 12000,
    timeoutMs: 180000,
    fallbacks: 'default',
    betas: [FALLBACK_BETA],
  },
};

/** One uploaded key frame, already face-blurred and cropped by the app (JPEG, long edge ≤ 768). */
export interface FrameImage {
  frameId: UploadFrameId;
  /** Base64 JPEG without a data: prefix. */
  jpegBase64: string;
}

/** The four usage meters (plus the 5m / 1h split of cache writes when the API reports it). */
export interface UsageMeters {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** Subset of cacheCreationInputTokens written with the 1-hour TTL (billed at 2× input). */
  cacheCreation1hInputTokens: number;
}

export const ZERO_USAGE: Readonly<UsageMeters> = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheCreation1hInputTokens: 0,
};
