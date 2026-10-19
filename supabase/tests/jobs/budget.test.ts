/** Spend controls (DESIGN.md §8.7): budget levels, the submit decision per audience, alerts. */
import { assertEquals } from '@std/assert';
import {
  budgetDecision,
  budgetLevel,
  maybeAlertDailySpend,
  parseBudgetStatus,
  userCostAlertThreshold,
} from '@shared/budget.ts';
import { checkSpend, ictMonth } from '@shared/jobs/index.ts';
import { captureLogger } from '@shared/testing/index.ts';
import { createBackend } from './_backend.ts';

const at = (spentUsd: number, budgetUsd = 30) =>
  parseBudgetStatus({ day: '2026-10-20', spentUsd, budgetUsd, alertRatio: 0.7, hardCapMult: 2 });

Deno.test('budget: levels at 0 / 70 % / 100 % / 2×', () => {
  assertEquals(budgetLevel(at(0)), 'ok');
  assertEquals(budgetLevel(at(20.9)), 'ok');
  assertEquals(budgetLevel(at(21)), 'alert');
  assertEquals(budgetLevel(at(30)), 'exhausted');
  assertEquals(budgetLevel(at(60)), 'hard_cap');
  assertEquals(budgetLevel(at(0, 0)), 'exhausted', 'a zero budget stops free traffic');
});

Deno.test('budget: numerics may arrive as strings; defaults fill gaps', () => {
  const s = parseBudgetStatus({ spentUsd: '22.5', budgetUsd: '30' });
  assertEquals(s.ratio, 0.75);
  assertEquals(s.alertRatio, 0.7);
  assertEquals(s.hardCapMult, 2);
});

Deno.test('budget: free users are downgraded at 70 % and refused at 100 %', () => {
  const free = { tier: 'free' as const, isReviewer: false };
  assertEquals(budgetDecision(at(10), free), { level: 'ok', allow: true, downgradeFreeStandard: false });
  assertEquals(budgetDecision(at(25), free), { level: 'alert', allow: true, downgradeFreeStandard: true });
  assertEquals(budgetDecision(at(30), free).allow, false);
});

Deno.test('budget: paid, trial and reviewer accounts are served up to 2× the budget', () => {
  for (
    const who of [
      { tier: 'premium' as const, isReviewer: false },
      { tier: 'trial' as const, isReviewer: false },
      { tier: 'free' as const, isReviewer: true },
    ]
  ) {
    assertEquals(budgetDecision(at(25), who), { level: 'alert', allow: true, downgradeFreeStandard: false });
    assertEquals(budgetDecision(at(45), who).allow, true);
    assertEquals(budgetDecision(at(60), who).allow, false);
  }
});

Deno.test('budget: the daily alert fires once per day', async () => {
  const b = createBackend();
  b.db.table('private', 'daily_spend').push({ day: '2026-10-20', cost_usd: 22, alerted_70: false });
  const { log, lines } = captureLogger();
  assertEquals(await maybeAlertDailySpend(b.db, at(10), log), false, 'below 70 %: nothing');
  assertEquals(await maybeAlertDailySpend(b.db, at(22), log), true);
  assertEquals(await maybeAlertDailySpend(b.db, at(29), log), false, 'already alerted today');
  assertEquals(lines.filter((l) => l.entry.alert === true).length, 1);
  assertEquals(b.db.table('public', 'events').map((e) => e.name), ['ops.spend_alert']);
});

Deno.test('budget: per-user monthly cost alert above 60 % of the estimated proceeds (paying tiers only)', async () => {
  const b = createBackend();
  const paid = '00000000-0000-4000-8000-0000000000a1';
  const cheap = '00000000-0000-4000-8000-0000000000a2';
  const free = '00000000-0000-4000-8000-0000000000a3';
  b.addUser(paid, { tier: 'premium' });
  b.addUser(cheap, { tier: 'premium' });
  b.addUser(free, { tier: 'free' });
  const month = ictMonth(b.now());
  b.db.table('private', 'user_monthly_cost').push(
    { user_id: paid, month, cost_usd: '1.20', alerted: false },
    { user_id: cheap, month, cost_usd: 0.3, alerted: false },
    { user_id: free, month, cost_usd: 5, alerted: false },
  );
  const { log } = captureLogger();
  const r = await checkSpend(b.db, log, b.now());
  assertEquals(r.userAlerts, 1);
  assertEquals(userCostAlertThreshold('premium'), 1.48 * 0.6);
  assertEquals(b.db.table('private', 'user_monthly_cost').find((x) => x.user_id === paid)!.alerted, true);
  assertEquals((await checkSpend(b.db, log, b.now())).userAlerts, 0, 'once per month');
});

Deno.test('budget: ICT month boundary', () => {
  assertEquals(ictMonth(new Date('2026-10-31T16:59:59Z')), '2026-10');
  assertEquals(ictMonth(new Date('2026-10-31T17:00:00Z')), '2026-11');
});
