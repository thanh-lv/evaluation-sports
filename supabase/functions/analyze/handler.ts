/**
 * Edge Function `analyze` (DESIGN.md §6.1): `GET /catalog`, `POST /prepare`, `POST /submit` (JWT) and `POST /run`
 * (`x-internal-secret`). Dependencies are injected so the routes run against fakes in tests.
 */
import { requireUser } from '@shared/auth.ts';
import { createRouter, json, route } from '@shared/http.ts';
import { buildCatalog, CatalogCache } from './catalog.ts';
import { type AnalyzeDeps, limitsOf } from './deps.ts';
import { handlePrepare } from './prepare.ts';
import { handleRun } from './run.ts';
import { handleSubmit } from './submit.ts';

export type { AnalyzeDeps } from './deps.ts';

export function createAnalyzeHandler(deps: AnalyzeDeps): (req: Request) => Promise<Response> {
  const limits = limitsOf(deps);
  const catalog = new CatalogCache(limits.catalogTtlMs);
  const maxAge = Math.floor(limits.catalogTtlMs / 1000);

  return createRouter({ fn: 'analyze', logger: deps.logger }, [
    route('GET', '/catalog', async (req) => {
      await requireUser(req, deps.verifier);
      const body = await catalog.get(() => buildCatalog(deps.db));
      return json(body, 200, { 'cache-control': `private, max-age=${maxAge}` });
    }),
    route('POST', '/prepare', async (req, ctx) => {
      const user = await requireUser(req, deps.verifier);
      return handlePrepare(req, ctx, deps, user, limits, catalog);
    }),
    route('POST', '/submit', async (req, ctx) => {
      const user = await requireUser(req, deps.verifier);
      return handleSubmit(req, ctx, deps, user);
    }),
    route('POST', '/run', (req, ctx) => handleRun(req, ctx, deps)),
  ]);
}
