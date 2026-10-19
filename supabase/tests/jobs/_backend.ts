/**
 * In-memory stand-ins for the job, quota and cron SQL functions (migrations 0400, 0700, 1100) on a FakeDb, with a
 * controllable clock. Close enough for handler and job unit tests; the real functions are covered by pgTAP
 * (040_reserve, 050_jobs, 120_jobs_fixes) and by the e2e flow.
 *
 * Simplifications: one quota counter per user (no periods), refunds always succeed (no retry cap), the 8-minute
 * lock TTL and attempt fencing are exact.
 */
import type { Row } from '@shared/db.ts';
import { createFakeStorage, FakeDb, type MemoryStorage } from '@shared/testing/index.ts';
import type { StorageService } from '@shared/storage.ts';

export const T0 = Date.parse('2026-10-20T03:00:00Z');
export const LOCK_TTL_MS = 8 * 60_000;

export interface PlanLimit {
  total: number;
  standard: number;
  firstEverStandard: boolean;
}

export const PLANS: Record<string, PlanLimit> = {
  free: { total: 2, standard: 0, firstEverStandard: true },
  trial: { total: 10, standard: 5, firstEverStandard: false },
  premium: { total: 15, standard: 15, firstEverStandard: false },
};

export interface UserState {
  tier: 'free' | 'trial' | 'premium';
  consent: boolean;
  isReviewer: boolean;
  used: number;
  usedStandard: number;
  bonusUsed: boolean;
  lifetimeUsed: number;
}

export interface LedgerRow {
  analysisId: string;
  userId: string;
  kind: string;
  bonus: boolean;
  state: 'reserved' | 'committed' | 'refunded';
  reason: string | null;
}

export interface Backend {
  db: FakeDb;
  storage: StorageService;
  memory: MemoryStorage;
  clock: { now: number };
  now: () => Date;
  users: Map<string, UserState>;
  ledger: Map<string, LedgerRow>;
  budget: { spentUsd: number; budgetUsd: number; alertRatio: number; hardCapMult: number };
  rateCounts: Map<string, number>;
  addUser(id: string, patch?: Partial<UserState>): UserState;
  analysis(id: string): Row | undefined;
  result(id: string): Row | undefined;
  advance(ms: number): void;
  /** Seeds a submitted job (status queued, ledger reserved) from a prepared state. */
  seedJob(row: Row): Row;
}

const iso = (ms: number) => new Date(ms).toISOString();
const ms = (v: unknown) => (typeof v === 'string' ? Date.parse(v) : NaN);

export function createBackend(): Backend {
  const db = new FakeDb();
  const { storage, memory } = createFakeStorage();
  const clock = { now: T0 };
  const users = new Map<string, UserState>();
  const ledger = new Map<string, LedgerRow>();
  const budget = { spentUsd: 0, budgetUsd: 30, alertRatio: 0.7, hardCapMult: 2 };
  const rateCounts = new Map<string, number>();
  const analyses = () => db.table('public', 'analyses');
  const find = (id: unknown) => analyses().find((r) => r.id === id);

  const refund = (aid: string, reason: string) => {
    const l = ledger.get(aid);
    if (!l || l.state !== 'reserved') return;
    const u = users.get(l.userId)!;
    u.used = Math.max(0, u.used - 1);
    u.lifetimeUsed = Math.max(0, u.lifetimeUsed - 1);
    if (l.kind === 'standard') u.usedStandard = Math.max(0, u.usedStandard - 1);
    if (l.bonus) u.bonusUsed = false;
    l.state = 'refunded';
    l.reason = reason;
  };
  const commit = (aid: string) => {
    const l = ledger.get(aid);
    if (l && l.state === 'reserved') l.state = 'committed';
  };
  const fenced = (args: Record<string, unknown>) => {
    const r = find(args.p_analysis_id);
    return r && r.status === 'processing' && r.attempt_count === args.p_attempt ? r : null;
  };
  const inFlight = (uid: string) =>
    analyses().filter((r) => r.user_id === uid && (r.status === 'queued' || r.status === 'processing')).length;
  const bonusAvailable = (u: UserState) =>
    u.tier === 'free' && PLANS.free.firstEverStandard && !u.bonusUsed && u.lifetimeUsed === 0;

  db.onRpc('private', 'claim_analysis', ({ p_analysis_id }) => {
    const r = find(p_analysis_id);
    if (!r) return null;
    const due = r.status === 'queued' && (r.next_attempt_at == null || ms(r.next_attempt_at) <= clock.now);
    const stale = r.status === 'processing' && ms(r.locked_at) < clock.now - LOCK_TTL_MS;
    if (!due && !stale) return null;
    r.status = 'processing';
    r.locked_at = iso(clock.now);
    r.attempt_count = (r.attempt_count as number) + 1;
    return r.attempt_count;
  });
  db.onRpc('private', 'finalize_analysis', (a) => {
    const result = a.p_result as Record<string, unknown>;
    const r = fenced(a);
    if (!r) return false;
    r.status = result.status;
    r.completed_at = iso(clock.now);
    r.locked_at = null;
    r.next_attempt_at = null;
    r.model = a.p_model;
    if (!db.table('public', 'analysis_results').some((x) => x.analysis_id === r.id)) {
      db.table('public', 'analysis_results').push({
        analysis_id: r.id,
        user_id: r.user_id,
        status: result.status,
        overall_score: a.p_overall_score,
        result: structuredClone(result),
      });
    }
    const partial = (result.overall as { partial?: boolean } | undefined)?.partial === true;
    if (result.status === 'rejected') refund(r.id as string, 'rejected');
    else if (partial) refund(r.id as string, 'partial');
    else commit(r.id as string);
    return true;
  });
  db.onRpc('private', 'requeue_analysis', (a) => {
    const r = fenced(a);
    if (!r) return false;
    r.status = 'queued';
    r.locked_at = null;
    r.next_attempt_at = iso(clock.now + Math.max(0, Number(a.p_delay_s)) * 1000);
    r.last_error_code = a.p_code;
    if (a.p_max_tokens_mult != null) r.max_tokens_mult = a.p_max_tokens_mult;
    return true;
  });
  db.onRpc('private', 'fail_analysis', (a) => {
    const r = fenced(a);
    if (!r) return false;
    r.status = 'failed';
    r.failure_code = a.p_code;
    r.completed_at = iso(clock.now);
    r.locked_at = null;
    r.next_attempt_at = null;
    refund(r.id as string, a.p_code as string);
    return true;
  });
  db.onRpc('private', 'reserve_for_submit', ({ p_user_id, p_analysis_id, p_device_bonus_ok }) => {
    const r = find(p_analysis_id);
    const u = users.get(p_user_id as string);
    if (!r || !u || r.user_id !== p_user_id) return { ok: false, code: 'analysis_not_found' };
    const plan = PLANS[u.tier];
    if (['queued', 'processing', 'succeeded'].includes(r.status as string)) {
      return { ok: true, idempotent: true, status: r.status, kind: r.kind, tier: u.tier };
    }
    if (r.status !== 'prepared') return { ok: false, code: 'analysis_conflict', status: r.status };
    if (inFlight(p_user_id as string) >= 1) {
      return { ok: false, code: 'in_flight', limit: 1, used: inFlight(p_user_id as string) };
    }
    if (u.used >= plan.total) {
      return {
        ok: false,
        code: 'quota_exceeded',
        limit: plan.total,
        used: u.used,
        resets_at: '2026-11-01T00:00:00+07:00',
      };
    }
    const bonus = u.tier === 'free' && p_device_bonus_ok === true && bonusAvailable(u);
    const kind = u.tier === 'free'
      ? (bonus ? 'standard' : 'basic')
      : u.usedStandard < plan.standard
      ? 'standard'
      : 'basic';
    ledger.set(r.id as string, {
      analysisId: r.id as string,
      userId: p_user_id as string,
      kind,
      bonus,
      state: 'reserved',
      reason: null,
    });
    u.used++;
    u.lifetimeUsed++;
    if (kind === 'standard') u.usedStandard++;
    if (bonus) u.bonusUsed = true;
    Object.assign(r, { status: 'queued', kind, queued_at: iso(clock.now), next_attempt_at: iso(clock.now) });
    return { ok: true, idempotent: false, status: 'queued', kind, tier: u.tier, bonus, remaining: plan.total - u.used };
  });
  db.onRpc('private', 'quota_status', ({ p_user_id }) => {
    const u = users.get(p_user_id as string)!;
    const plan = PLANS[u.tier];
    const next = u.tier === 'free'
      ? (bonusAvailable(u) ? 'standard' : 'basic')
      : u.usedStandard < plan.standard
      ? 'standard'
      : 'basic';
    return {
      tier: u.tier,
      remaining: Math.max(plan.total - u.used, 0),
      nextKind: next,
      resets_at: u.tier === 'trial' ? null : '2026-11-01T00:00:00+07:00',
      bonusAvailable: bonusAvailable(u),
    };
  });
  db.onRpc('private', 'consent_current', ({ p_user_id }) => users.get(p_user_id as string)?.consent === true);
  db.onRpc('private', 'tier_of', ({ p_user_id }) => users.get(p_user_id as string)?.tier ?? 'free');
  db.onRpc('private', 'budget_status', () => ({
    day: '2026-10-20',
    spentUsd: budget.spentUsd,
    budgetUsd: budget.budgetUsd,
    ratio: budget.budgetUsd > 0 ? budget.spentUsd / budget.budgetUsd : null,
    alertRatio: budget.alertRatio,
    hardCapMult: budget.hardCapMult,
  }));
  db.onRpc('private', 'record_llm_cost', ({ p_user_id, p_cost_usd }) => {
    budget.spentUsd += Number(p_cost_usd);
    const days = db.table('private', 'daily_spend');
    let day = days.find((d) => d.day === '2026-10-20');
    if (!day) {
      day = { day: '2026-10-20', cost_usd: 0, calls: 0, alerted_70: false };
      days.push(day);
    }
    day.cost_usd = Number(day.cost_usd) + Number(p_cost_usd);
    day.calls = Number(day.calls) + 1;
    if (p_user_id) {
      const months = db.table('private', 'user_monthly_cost');
      let m = months.find((x) => x.user_id === p_user_id && x.month === '2026-10');
      if (!m) {
        m = { user_id: p_user_id, month: '2026-10', cost_usd: 0, calls: 0, alerted: false };
        months.push(m);
      }
      m.cost_usd = Number(m.cost_usd) + Number(p_cost_usd);
    }
    return { dayUsd: day.cost_usd };
  });
  db.onRpc('private', 'rate_limit_hit', ({ p_user_id, p_bucket, p_limit }) => {
    const key = `${p_user_id}|${p_bucket}`;
    const n = (rateCounts.get(key) ?? 0) + 1;
    rateCounts.set(key, n);
    return { allowed: n <= Number(p_limit), count: n, limit: p_limit, resetAt: iso(clock.now + 1800_000) };
  });
  db.onRpc('private', 'upsert_prepared_analysis', ({ p_user_id, p_analysis_id, p_fields }) => {
    const f = p_fields as Row;
    const r = find(p_analysis_id);
    if (r) {
      if (r.user_id !== p_user_id || !['prepared', 'rejected'].includes(r.status as string)) return false;
      Object.assign(r, f, { status: f.status ?? 'prepared', updated_at: iso(clock.now) });
      if (r.status !== 'rejected') r.failure_code = null;
      return true;
    }
    analyses().push({
      id: p_analysis_id,
      user_id: p_user_id,
      attempt_count: 0,
      max_tokens_mult: 1,
      kind: null,
      created_at: iso(clock.now),
      updated_at: iso(clock.now),
      ...f,
      status: f.status ?? 'prepared',
    });
    return true;
  });
  db.onRpc('private', 'purge_expired_rows', () => ({ events: 0, llmOutputs: 0, appstoreNotifications: 0 }));
  db.onRpc('private', 'cron_purge_rate_limits', () => 0);
  db.onRpc('private', 'cron_stale_jobs', ({ p_older_than_s }) =>
    analyses()
      .filter((r) => ['queued', 'processing'].includes(r.status as string))
      .filter((r) => ms(r.queued_at ?? r.created_at) < clock.now - Number(p_older_than_s) * 1000)
      .map((r) => ({ id: r.id, user_id: r.user_id, status: r.status })));
  db.onRpc('private', 'cron_expired_drafts', ({ p_older_than_s }) =>
    analyses()
      .filter((r) => ['prepared', 'rejected'].includes(r.status as string) && !ledger.has(r.id as string))
      .filter((r) => !db.table('public', 'analysis_results').some((x) => x.analysis_id === r.id))
      .filter((r) => ms(r.updated_at ?? r.created_at) < clock.now - Number(p_older_than_s) * 1000)
      .map((r) => ({ id: r.id, user_id: r.user_id })));
  db.onRpc('private', 'cron_inactive_pose', () =>
    analyses()
      .filter((r) => r.inactive_owner === true && (r.pose_raw_path || r.pose_clean_path))
      .map((r) => ({
        id: r.id,
        user_id: r.user_id,
        pose_raw_path: r.pose_raw_path ?? null,
        pose_clean_path: r.pose_clean_path ?? null,
      })));
  db.onRpc('private', 'recent_model_use', () => db.table('private', 'recent_model_use'));

  const backend: Backend = {
    db,
    storage,
    memory,
    clock,
    now: () => new Date(clock.now),
    users,
    ledger,
    budget,
    rateCounts,
    addUser(id, patch = {}) {
      const u: UserState = {
        tier: 'free',
        consent: true,
        isReviewer: false,
        used: 0,
        usedStandard: 0,
        bonusUsed: false,
        lifetimeUsed: 0,
        ...patch,
      };
      users.set(id, u);
      db.table('public', 'profiles').push({ id, is_reviewer: u.isReviewer });
      return u;
    },
    analysis: (id) => find(id),
    result: (id) => db.table('public', 'analysis_results').find((x) => x.analysis_id === id),
    advance(delta) {
      clock.now += delta;
    },
    seedJob(row) {
      const full: Row = {
        status: 'queued',
        attempt_count: 0,
        max_tokens_mult: 1,
        kind: 'standard',
        language: 'vi',
        frame_mode: 'frames',
        queued_at: iso(clock.now),
        next_attempt_at: iso(clock.now),
        created_at: iso(clock.now),
        updated_at: iso(clock.now),
        ...row,
      };
      analyses().push(full);
      ledger.set(full.id as string, {
        analysisId: full.id as string,
        userId: full.user_id as string,
        kind: full.kind as string,
        bonus: false,
        state: 'reserved',
        reason: null,
      });
      const u = users.get(full.user_id as string);
      if (u) {
        u.used++;
        u.lifetimeUsed++;
      }
      return full;
    },
  };
  return backend;
}
