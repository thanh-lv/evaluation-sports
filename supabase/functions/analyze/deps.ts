/** Injected dependencies of the `analyze` function (real ones in index.ts, fakes in supabase/tests/functions). */
import type { ClaimsVerifier } from '@shared/auth.ts';
import {
  type AnthropicClientOptions,
  anthropicCoachClient,
  type CoachModelClient,
  mockCoachClient,
  type MockSource,
} from '@shared/claude/index.ts';
import type { ClaudeMode } from '@shared/env.ts';
import { ConfigError } from '@shared/errors.ts';
import type { Db } from '@shared/db.ts';
import type { DeviceCheckClient } from '@shared/apple/devicecheck.ts';
import { runInBackground } from '@shared/http.ts';
import type { InFlightJobs, JobDeps } from '@shared/jobs/index.ts';
import type { Logger } from '@shared/log.ts';
import type { StorageService } from '@shared/storage.ts';

export interface AnalyzeLimits {
  /** pose.v1 bodies per user per hour (§6.1). */
  preparePerHour: number;
  /** reprepare.v1 bodies per user per hour (engine CPU; not in the spec, generous). */
  reprepPerHour: number;
  /** In-memory catalog cache (the response also says `max-age`). */
  catalogTtlMs: number;
}

export const DEFAULT_ANALYZE_LIMITS: AnalyzeLimits = {
  preparePerHour: 20,
  reprepPerHour: 60,
  catalogTtlMs: 3600_000,
};

export interface AnalyzeDeps {
  db: Db;
  storage: StorageService;
  verifier: ClaimsVerifier;
  /** `INTERNAL_SECRET` for /run (pg_net dispatcher). */
  internalSecret: string | null;
  /** DeviceCheck two-bit client; null when not configured (the first-ever bonus is then unavailable). */
  deviceCheck: DeviceCheckClient | null;
  coachClient: (src: MockSource) => CoachModelClient;
  logger?: Logger;
  inflight?: InFlightJobs;
  now?: () => Date;
  limits?: Partial<AnalyzeLimits>;
  /** Background runner (default: EdgeRuntime.waitUntil); tests collect the promises. */
  background?: (task: Promise<unknown>, log: Logger) => Promise<void>;
}

export function limitsOf(deps: AnalyzeDeps): AnalyzeLimits {
  return { ...DEFAULT_ANALYZE_LIMITS, ...(deps.limits ?? {}) };
}

export function backgroundOf(deps: AnalyzeDeps): (task: Promise<unknown>, log: Logger) => Promise<void> {
  return deps.background ?? runInBackground;
}

export function jobDepsOf(deps: AnalyzeDeps, log: Logger): JobDeps {
  return {
    db: deps.db,
    storage: deps.storage,
    coachClient: deps.coachClient,
    log,
    now: deps.now,
    inflight: deps.inflight,
  };
}

/**
 * The per-analysis client factory for `CLAUDE_MODE`. Mock only when the mode says so: live mode without a key gets a
 * factory that throws a ConfigError (the job then fails `internal` with an operator alert and a refund), never the
 * mock generator. One SDK client per worker in live mode.
 */
export function coachClientFactory(
  mode: ClaudeMode,
  apiKey: string | null,
  makeLive: (opts: AnthropicClientOptions) => CoachModelClient = anthropicCoachClient,
): (src: MockSource) => CoachModelClient {
  if (mode === 'mock') return (src) => mockCoachClient(src);
  if (!apiKey) {
    return () => {
      throw new ConfigError('ANTHROPIC_API_KEY is not set (CLAUDE_MODE=mock must be explicit for local dev)');
    };
  }
  const live = makeLive({ apiKey });
  return () => live;
}
