/**
 * Daily spend checks (DESIGN.md §8.7): today's 70 % budget alert (also fired by the job after each call) and the
 * per-user alert when a paying user's LLM cost this ICT month passes 60 % of the estimated proceeds.
 */
import type { Tier } from '@shared/contracts/index.ts';
import type { Db } from '../db.ts';
import type { Logger } from '../log.ts';
import { loadBudgetStatus, maybeAlertDailySpend, operatorAlert, userCostAlertThreshold } from '../budget.ts';

/** `YYYY-MM` of the ICT month containing `now` (ICT is a fixed +07:00). */
export function ictMonth(now: Date): string {
  return new Date(now.getTime() + 7 * 3600_000).toISOString().slice(0, 7);
}

const MIN_THRESHOLD = Math.min(
  ...(['trial', 'premium'] as const).map((t) => userCostAlertThreshold(t) ?? Infinity),
);

export interface SpendCheckResult {
  dayRatio: number | null;
  dayAlerted: boolean;
  userAlerts: number;
}

export async function checkSpend(db: Db, log: Logger, now: Date = new Date()): Promise<SpendCheckResult> {
  const status = await loadBudgetStatus(db);
  const dayAlerted = await maybeAlertDailySpend(db, status, log);

  const month = ictMonth(now);
  const rows = await db.selectMany<{ user_id: string; cost_usd: number | string }>(
    'private',
    'user_monthly_cost',
    'user_id, cost_usd',
    { month, alerted: false },
  );
  let userAlerts = 0;
  for (const r of rows) {
    const cost = Number(r.cost_usd);
    if (!(cost > MIN_THRESHOLD)) continue;
    const tier = await db.rpc<Tier>('private', 'tier_of', { p_user_id: r.user_id });
    const threshold = userCostAlertThreshold(tier);
    if (threshold === null || cost <= threshold) continue;
    const flipped = await db.update('private', 'user_monthly_cost', { alerted: true }, {
      user_id: r.user_id,
      month,
      alerted: false,
    });
    if (flipped === 0) continue;
    userAlerts++;
    await operatorAlert(db, log, 'user_cost_alert', { month, tier, costUsd: cost, thresholdUsd: threshold }, r.user_id);
  }
  return { dayRatio: status.ratio, dayAlerted, userAlerts };
}
