/**
 * Cron tasks (DESIGN.md §6.1 `/cron {task}`, §6.6, §8.2, §8.7, §9.5):
 * - `daily`: retention steps, App Store notification history (Production + Sandbox), spend alerts and, in live mode,
 *   the schema warm-up;
 * - `warm`: the schema warm-up only (live mode only; mock mode has no grammar to warm).
 * Every step is isolated: one failing step is logged and the others still run.
 */
import type { CoachModelClient } from '@shared/claude/index.ts';
import type { ClaudeMode } from '../env.ts';
import { errorFields } from '../log.ts';
import {
  cleanOrphans,
  deleteExpiredDrafts,
  expireStaleJobs,
  purgeInactivePose,
  purgeRows,
  type RetentionDeps,
  type WalkOptions,
} from './retention.ts';
import { checkSpend } from './spend.ts';
import { warmStaleSchemas } from './warm.ts';

export const CRON_TASKS = ['daily', 'warm'] as const;
export type CronTask = (typeof CRON_TASKS)[number];

export interface CronDeps extends RetentionDeps {
  claudeMode: ClaudeMode;
  /** Live model client for the warm-up; null when not configured. */
  warmClient: (() => CoachModelClient) | null;
  /** App Store notification history sync; null when Apple is not configured. */
  syncNotifications: (() => Promise<unknown>) | null;
  walk?: WalkOptions;
}

export type StepResult = { ok: true; value: unknown } | { ok: false; error: string } | { ok: true; skipped: string };

async function step(deps: CronDeps, name: string, fn: () => Promise<unknown>): Promise<StepResult> {
  const t0 = Date.now();
  try {
    const value = await fn();
    deps.log.info('cron step', { step: name, ms: Date.now() - t0, result: value as Record<string, unknown> });
    return { ok: true, value };
  } catch (err) {
    deps.log.error('cron step failed', { step: name, ...errorFields(err) });
    return { ok: false, error: (err as Error).message ?? String(err) };
  }
}

function warm(deps: CronDeps): Promise<StepResult> {
  if (deps.claudeMode !== 'live') return Promise.resolve({ ok: true, skipped: 'CLAUDE_MODE is not live' });
  if (!deps.warmClient) return Promise.resolve({ ok: true, skipped: 'no live client' });
  const makeClient = deps.warmClient;
  return step(deps, 'warm', () => warmStaleSchemas({ db: deps.db, client: makeClient(), log: deps.log }));
}

export async function runCronTask(task: CronTask, deps: CronDeps): Promise<Record<string, StepResult>> {
  const out: Record<string, StepResult> = {};
  if (task === 'warm') {
    out.warm = await warm(deps);
    return out;
  }
  const now = () => deps.now?.() ?? new Date();
  out.staleJobs = await step(deps, 'stale_jobs', () => expireStaleJobs(deps));
  out.drafts = await step(deps, 'drafts', () => deleteExpiredDrafts(deps));
  out.orphans = await step(deps, 'orphans', () => cleanOrphans(deps, deps.walk));
  out.inactivePose = await step(deps, 'inactive_pose', () => purgeInactivePose(deps));
  out.rows = await step(deps, 'purge_rows', () => purgeRows(deps.db));
  out.notifications = deps.syncNotifications
    ? await step(deps, 'notification_history', deps.syncNotifications)
    : { ok: true, skipped: 'Apple App Store API not configured' };
  out.spend = await step(deps, 'spend', () => checkSpend(deps.db, deps.log, now()));
  out.warm = await warm(deps);
  return out;
}
