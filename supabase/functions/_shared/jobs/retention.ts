/**
 * Retention steps of the daily cron (DESIGN.md §6.6). Each step is chunked (SQL limits, a time budget for the walk)
 * and idempotent, so a partial run is finished by the next one.
 *
 * | Data             | Rule                                                                                     |
 * |------------------|------------------------------------------------------------------------------------------|
 * | Key frames       | Deleted at finalize; jobs still queued/processing after 72 h are claimed, failed         |
 * |                  | (`expired`, refund) and their frames removed; failed jobs keep frames for 72 h            |
 * | `prepared` rows  | Drafts untouched for 24 h are deleted with their files                                    |
 * | Orphan folders   | Recursive walk of both buckets: folders without an analysis row are removed               |
 * | Pose JSON        | Deleted after 24 months of user inactivity (paths cleared)                                |
 * | `llm_outputs`    | 90 days (`purge_expired_rows`); `events` 13 months; rate-limit windows 2 days             |
 */
import type { Db } from '../db.ts';
import { errorFields, type Logger } from '../log.ts';
import { BUCKET_DERIVED, BUCKET_INPUTS, type StorageService } from '../storage.ts';
import { deleteFrames } from './frames.ts';
import { claimAnalysis, failAnalysis } from './store.ts';

export const RETENTION = {
  staleJobAfterS: 72 * 3600,
  draftAfterS: 24 * 3600,
  failedFramesKeepMs: 72 * 3600_000,
  inactivePoseMonths: 24,
  chunk: 200,
  walkBudgetMs: 60_000,
} as const;

export interface RetentionDeps {
  db: Db;
  storage: StorageService;
  log: Logger;
  now?: () => Date;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 72 h cap: claim (fencing) before failing, so a live worker's job is never failed under it. */
export async function expireStaleJobs(deps: RetentionDeps): Promise<{ expired: number; skipped: number }> {
  const rows = await deps.db.rpc<{ id: string; user_id: string; status: string }[]>('private', 'cron_stale_jobs', {
    p_older_than_s: RETENTION.staleJobAfterS,
    p_limit: RETENTION.chunk,
  });
  let expired = 0;
  let skipped = 0;
  for (const r of rows ?? []) {
    const attempt = await claimAnalysis(deps.db, r.id);
    if (attempt === null || !(await failAnalysis(deps.db, r.id, attempt, 'expired'))) {
      skipped++; // a worker holds a fresh lock, or the job is backing off: next run
      continue;
    }
    expired++;
    await deleteFrames(deps.storage, r.user_id, r.id);
  }
  return { expired, skipped };
}

/** Drafts (prepared, or rejected by prepare) older than 24 h: row first (status-guarded), then its files. */
export async function deleteExpiredDrafts(deps: RetentionDeps): Promise<{ deleted: number }> {
  const rows = await deps.db.rpc<{ id: string; user_id: string }[]>('private', 'cron_expired_drafts', {
    p_older_than_s: RETENTION.draftAfterS,
    p_limit: RETENTION.chunk,
  });
  let deleted = 0;
  for (const r of rows ?? []) {
    const n = await deps.db.delete('public', 'analyses', { id: r.id, status: 'prepared' }) ||
      await deps.db.delete('public', 'analyses', { id: r.id, status: 'rejected' });
    if (n === 0) continue; // submitted meanwhile
    deleted++;
    for (const bucket of [BUCKET_INPUTS, BUCKET_DERIVED]) {
      await deps.storage.removePrefix(bucket, `${r.user_id}/${r.id}`);
    }
  }
  return { deleted };
}

/** Pose JSON of users inactive for 24 months: files removed, paths cleared (the analysis row and result stay). */
export async function purgeInactivePose(deps: RetentionDeps): Promise<{ analyses: number }> {
  const rows = await deps.db.rpc<
    { id: string; user_id: string; pose_raw_path: string | null; pose_clean_path: string | null }[]
  >('private', 'cron_inactive_pose', { p_months: RETENTION.inactivePoseMonths, p_limit: RETENTION.chunk });
  let n = 0;
  for (const r of rows ?? []) {
    const paths = [r.pose_raw_path, r.pose_clean_path].filter((p): p is string => !!p);
    if (paths.length) await deps.storage.remove(BUCKET_DERIVED, paths);
    await deps.db.update('public', 'analyses', { pose_raw_path: null, pose_clean_path: null }, { id: r.id });
    n++;
  }
  return { analyses: n };
}

interface WalkRow {
  id: string;
  status: string;
  completed_at: string | null;
}

/** Frames stay while the job can still run, and for 72 h after a failure (debugging, support). */
export function keepFrames(row: WalkRow, now: Date): boolean {
  if (row.status === 'prepared' || row.status === 'queued' || row.status === 'processing') return true;
  if (row.status === 'failed' && row.completed_at) {
    return now.getTime() - Date.parse(row.completed_at) < RETENTION.failedFramesKeepMs;
  }
  return false;
}

export interface WalkResult {
  users: number;
  orphanFolders: number;
  frameFolders: number;
  complete: boolean;
}

export interface WalkOptions {
  budgetMs?: number;
  /** Index of the first user folder (default random, so a walk cut by the budget covers other users next time). */
  startAt?: number;
}

/**
 * Recursive walk of both buckets, one user folder at a time: `{uid}/{aid}/…` without an analysis row of that user is
 * removed (deleted users, deleted analyses, failed prepares); leftover frames of finished jobs are removed too.
 */
export async function cleanOrphans(deps: RetentionDeps, options: WalkOptions = {}): Promise<WalkResult> {
  const now = deps.now?.() ?? new Date();
  const deadline = Date.now() + (options.budgetMs ?? RETENTION.walkBudgetMs);
  const users = new Set<string>();
  for (const bucket of [BUCKET_INPUTS, BUCKET_DERIVED]) {
    for (const e of await deps.storage.list(bucket, '')) if (e.isFolder) users.add(e.name);
  }
  const order = [...users].sort();
  const start = order.length ? (options.startAt ?? Math.floor(Math.random() * order.length)) % order.length : 0;
  const result: WalkResult = { users: 0, orphanFolders: 0, frameFolders: 0, complete: true };

  for (let i = 0; i < order.length; i++) {
    if (Date.now() > deadline) {
      result.complete = false;
      break;
    }
    const uid = order[(start + i) % order.length];
    if (!UUID_RE.test(uid)) {
      deps.log.warn('storage walk: unexpected top-level folder', { folder: uid.slice(0, 64) });
      continue;
    }
    try {
      await walkUser(deps, uid, now, result);
      result.users++;
    } catch (err) {
      deps.log.warn('storage walk failed for a user folder', errorFields(err));
    }
  }
  return result;
}

async function walkUser(deps: RetentionDeps, uid: string, now: Date, result: WalkResult): Promise<void> {
  const rows = await deps.db.selectMany<WalkRow>('public', 'analyses', 'id, status, completed_at', { user_id: uid });
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const bucket of [BUCKET_INPUTS, BUCKET_DERIVED]) {
    for (const entry of await deps.storage.list(bucket, uid)) {
      if (!entry.isFolder) {
        await deps.storage.remove(bucket, [entry.path]); // nothing belongs directly under {uid}/
        continue;
      }
      const row = byId.get(entry.name);
      if (!row) {
        if (await deps.storage.removePrefix(bucket, entry.path)) result.orphanFolders++;
      } else if (bucket === BUCKET_INPUTS && !keepFrames(row, now)) {
        if (await deps.storage.removePrefix(bucket, entry.path)) result.frameFolders++;
      }
    }
  }
}

/** events (13 months), llm_outputs (90 days), processed notifications, expired rate-limit windows. */
export async function purgeRows(db: Db): Promise<Record<string, unknown>> {
  const rows = await db.rpc<Record<string, unknown>>('private', 'purge_expired_rows');
  const rateLimits = await db.rpc<number>('private', 'cron_purge_rate_limits');
  return { ...(rows ?? {}), rateLimits };
}
