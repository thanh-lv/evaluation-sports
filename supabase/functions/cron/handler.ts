/**
 * Edge Function `cron` (DESIGN.md §6.1): `POST /cron {task: daily | warm}` with `x-cron-secret`, called by pg_cron
 * through pg_net (`private.call_cron_task`). Answers 202 at once and does the work in the background (chunked and
 * idempotent; see `_shared/jobs/daily.ts`).
 */
import { z } from 'zod';
import { CRON_SECRET_HEADER, requireSecret } from '@shared/auth.ts';
import { createRouter, json, parseJson, route, runInBackground } from '@shared/http.ts';
import { CRON_TASKS, type CronDeps, runCronTask } from '@shared/jobs/index.ts';
import type { Logger } from '@shared/log.ts';

export interface CronHandlerDeps extends Omit<CronDeps, 'log'> {
  cronSecret: string | null;
  logger?: Logger;
  /** Background runner (default: EdgeRuntime.waitUntil); tests collect the promises. */
  background?: (task: Promise<unknown>, log: Logger) => Promise<void>;
}

const CronRequest = z.object({ task: z.enum(CRON_TASKS) });

export function createCronHandler(deps: CronHandlerDeps): (req: Request) => Promise<Response> {
  const background = deps.background ?? runInBackground;
  return createRouter({ fn: 'cron', logger: deps.logger, cors: false }, [
    route('POST', '/', async (req, ctx) => {
      requireSecret(req, CRON_SECRET_HEADER, deps.cronSecret);
      const { task } = await parseJson(req, CronRequest);
      const log = ctx.log.child({ task });
      void background(
        runCronTask(task, { ...deps, log }).then((steps) => log.info('cron task finished', { steps })),
        log,
      );
      return json({ accepted: true, task }, 202);
    }),
  ]);
}
