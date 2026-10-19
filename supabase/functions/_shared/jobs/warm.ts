/**
 * Cron `warm` (DESIGN.md §8.2 "Grammar warm-up"): for each model × sport that served no call in the last 20 h, one
 * tiny request with the real schema (`warmOnce`), so the grammar is compiled and the rubric prefix cached. Live mode
 * only. Warm-up calls are logged in `llm_calls` under a fixed marker id per sport (attempt 0) and their cost counts
 * toward the daily budget.
 */
import type { Sport } from '@shared/contracts/index.ts';
import { type CoachModelClient, warmOnce, type WarmResult } from '@shared/claude/index.ts';
import type { Db } from '../db.ts';
import { errorFields, type Logger } from '../log.ts';
import { operatorAlert } from '../budget.ts';
import { loadAllModelRoutes, recordLlmCall, recordLlmCost } from './store.ts';

export const WARM_WINDOW_HOURS = 20;
/** `llm_calls.analysis_id` of warm-up calls (match no analysis; `recent_model_use` returns them as markers). */
export const WARM_MARKER_IDS: Readonly<Record<Sport, string>> = {
  badminton: '00000000-0000-4000-8000-0000000000b1',
  pickleball: '00000000-0000-4000-8000-0000000000b2',
};
const SPORTS: readonly Sport[] = ['badminton', 'pickleball'];

export interface WarmDeps {
  db: Db;
  client: CoachModelClient;
  log: Logger;
}

export interface WarmSummary {
  warmed: { model: string; sport: Sport; ok: boolean }[];
  skipped: number;
}

/** (model, sport) pairs with a served call in the window, warm-up markers included. */
export async function recentlyUsed(db: Db, hours = WARM_WINDOW_HOURS): Promise<Set<string>> {
  const rows = await db.rpc<{ model: string; sport: string | null; analysis_id: string | null }[]>(
    'private',
    'recent_model_use',
    { p_hours: hours },
  );
  const used = new Set<string>();
  for (const r of rows ?? []) {
    const sport = r.sport ?? SPORTS.find((s) => WARM_MARKER_IDS[s] === r.analysis_id) ?? null;
    if (sport) used.add(`${r.model}|${sport}`);
  }
  return used;
}

export async function warmStaleSchemas(deps: WarmDeps): Promise<WarmSummary> {
  const used = await recentlyUsed(deps.db);
  const routes = await loadAllModelRoutes(deps.db);
  const seen = new Set<string>();
  const summary: WarmSummary = { warmed: [], skipped: 0 };
  for (const route of routes) {
    for (const sport of SPORTS) {
      const key = `${route.model}|${sport}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (used.has(key)) {
        summary.skipped++;
        continue;
      }
      let res: WarmResult;
      try {
        res = await warmOnce(route, sport, { client: deps.client, log: deps.log });
      } catch (err) {
        deps.log.warn('warm-up threw', { model: route.model, sport, ...errorFields(err) });
        summary.warmed.push({ model: route.model, sport, ok: false });
        continue;
      }
      summary.warmed.push({ model: route.model, sport, ok: res.ok });
      try {
        await recordLlmCall(deps.db, {
          analysisId: WARM_MARKER_IDS[sport],
          attempt: 0,
          kind: route.kind,
          call: res.run.call,
          error: res.run.call.error,
        });
        if (res.run.call.costUsd > 0) await recordLlmCost(deps.db, null, res.run.call.costUsd);
      } catch (err) {
        deps.log.warn('warm-up accounting failed', errorFields(err));
      }
      if (!res.ok) {
        await operatorAlert(deps.db, deps.log, 'schema_warm_failed', {
          model: route.model,
          sport,
          error: res.run.call.error,
        });
      }
    }
  }
  return summary;
}
