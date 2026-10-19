/**
 * POST /analyze/run `{analysisId}` with `x-internal-secret` (DESIGN.md §6.1, D12): one job per call from the pg_cron
 * dispatcher (`private.dispatch_due_jobs`). Answers 202 at once; `runOnce` claims with fencing in the background, so
 * duplicate deliveries are harmless.
 */
import { z } from 'zod';
import { LowerUuid } from '@shared/contracts/index.ts';
import { INTERNAL_SECRET_HEADER, requireSecret } from '@shared/auth.ts';
import { json, parseJson, type RouteContext } from '@shared/http.ts';
import { runOnce } from '@shared/jobs/index.ts';
import { type AnalyzeDeps, backgroundOf, jobDepsOf } from './deps.ts';

const RunRequest = z.object({ analysisId: LowerUuid });

export async function handleRun(req: Request, ctx: RouteContext, deps: AnalyzeDeps): Promise<Response> {
  requireSecret(req, INTERNAL_SECRET_HEADER, deps.internalSecret);
  const { analysisId } = await parseJson(req, RunRequest);
  const log = ctx.log.child({ analysisId });
  void backgroundOf(deps)(
    runOnce(analysisId, jobDepsOf(deps, log)).then((r) => log.info('run finished', { result: r.status })),
    log,
  );
  return json({ accepted: true }, 202);
}
