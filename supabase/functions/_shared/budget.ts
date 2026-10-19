/**
 * Spend controls (DESIGN.md §8.7).
 *
 * - Daily budget `app_config.budget_usd` (ICT day, `private.budget_status()`):
 *   - below `budget_alert_ratio` (0.7): everyone is served;
 *   - from 70 %: one operator alert per day, and free standard requests are downgraded to basic (submit passes
 *     `device_bonus_ok = false` to reserve_for_submit);
 *   - from 100 %: free submits get 503 `busy_try_later` before any quota is reserved;
 *   - paid, trial and reviewer accounts are always served, up to `budget_hard_cap_mult` (2) × the budget.
 * - Per user: an operator alert when a paying user's LLM cost this ICT month exceeds 60 % of the estimated monthly
 *   proceeds (daily cron).
 *
 * Alerts are error-level log lines with `alert: true` plus a server event (`ops.*`), the only alert channel in MVP.
 */
import type { Tier } from '@shared/contracts/index.ts';
import type { Db } from './db.ts';
import { logServerEvent } from './events.ts';
import { errorFields, type Logger } from './log.ts';

export interface BudgetStatus {
  /** ICT day, `YYYY-MM-DD`. */
  day: string;
  spentUsd: number;
  budgetUsd: number;
  /** spent / budget; null when the budget is 0 or negative. */
  ratio: number | null;
  alertRatio: number;
  hardCapMult: number;
}

export type BudgetLevel = 'ok' | 'alert' | 'exhausted' | 'hard_cap';

export interface BudgetAudience {
  tier: Tier;
  isReviewer: boolean;
}

export interface BudgetDecision {
  level: BudgetLevel;
  /** false → 503 busy_try_later without reserving quota. */
  allow: boolean;
  /** true → a free first-ever standard request becomes basic (no DeviceCheck bonus). */
  downgradeFreeStandard: boolean;
}

function num(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

/** Parses `private.budget_status()` (numerics may arrive as numbers or strings). */
export function parseBudgetStatus(raw: unknown): BudgetStatus {
  const r = (raw ?? {}) as Record<string, unknown>;
  const spentUsd = num(r.spentUsd, 0);
  const budgetUsd = num(r.budgetUsd, 30);
  return {
    day: typeof r.day === 'string' ? r.day : '',
    spentUsd,
    budgetUsd,
    ratio: budgetUsd > 0 ? spentUsd / budgetUsd : null,
    alertRatio: num(r.alertRatio, 0.7),
    hardCapMult: num(r.hardCapMult, 2),
  };
}

export async function loadBudgetStatus(db: Db): Promise<BudgetStatus> {
  return parseBudgetStatus(await db.rpc('private', 'budget_status'));
}

/** Where today's spend sits. A budget of 0 (or less) counts as exhausted for free users, with no hard cap. */
export function budgetLevel(s: BudgetStatus): BudgetLevel {
  if (s.ratio === null) return 'exhausted';
  if (s.ratio >= s.hardCapMult) return 'hard_cap';
  if (s.ratio >= 1) return 'exhausted';
  if (s.ratio >= s.alertRatio) return 'alert';
  return 'ok';
}

/** The submit-time budget guard (§8.7). */
export function budgetDecision(s: BudgetStatus, who: BudgetAudience): BudgetDecision {
  const level = budgetLevel(s);
  const paying = who.tier !== 'free' || who.isReviewer;
  if (paying) {
    return { level, allow: level !== 'hard_cap', downgradeFreeStandard: false };
  }
  return {
    level,
    allow: level === 'ok' || level === 'alert',
    downgradeFreeStandard: level !== 'ok',
  };
}

/** One operator alert line + server event (never throws). */
export async function operatorAlert(
  db: Db,
  log: Logger,
  name: string,
  props: Record<string, unknown>,
  userId: string | null = null,
): Promise<void> {
  log.error(`alert: ${name}`, { alert: true, ...props });
  await logServerEvent(db, { name: `ops.${name}`, userId, props }, log);
}

/**
 * Fires the daily 70 % alert at most once per ICT day (`daily_spend.alerted_70` is flipped atomically, so only one
 * worker wins). Returns true when this call sent the alert.
 */
export async function maybeAlertDailySpend(db: Db, s: BudgetStatus, log: Logger): Promise<boolean> {
  const level = budgetLevel(s);
  if (level === 'ok' || !s.day) return false;
  try {
    const flipped = await db.update('private', 'daily_spend', { alerted_70: true }, { day: s.day, alerted_70: false });
    if (flipped === 0) return false;
    await operatorAlert(db, log, 'spend_alert', {
      day: s.day,
      spentUsd: s.spentUsd,
      budgetUsd: s.budgetUsd,
      ratio: s.ratio,
      level,
    });
    return true;
  } catch (err) {
    log.warn('spend alert check failed', errorFields(err));
    return false;
  }
}

/**
 * Estimated monthly proceeds per paying tier (§9.3 unit economics: VN yearly ≈ $1.48/month, the lowest plan). Free
 * users have no proceeds and are covered by the daily budget instead.
 */
export const ESTIMATED_MONTHLY_PROCEEDS_USD: Readonly<Record<Tier, number | null>> = {
  free: null,
  trial: 1.48,
  premium: 1.48,
};
export const USER_COST_ALERT_RATIO = 0.6;

/** Threshold above which a user's monthly LLM cost is alerted, or null for tiers without proceeds. */
export function userCostAlertThreshold(tier: Tier): number | null {
  const proceeds = ESTIMATED_MONTHLY_PROCEEDS_USD[tier];
  return proceeds === null ? null : proceeds * USER_COST_ALERT_RATIO;
}
