/** Edge Function `account-merge` (DESIGN §6.1, D14); the logic is in handler.ts. */
import { getClaimsVerifier } from '@shared/auth.ts';
import { getServiceClients } from '@shared/db.ts';
import { getEnv } from '@shared/env.ts';
import { createLogger } from '@shared/log.ts';
import { createAppStoreApiFromEnv } from '@shared/apple/api.ts';
import { createAccountMergeHandler } from './handler.ts';

const env = getEnv();
const clients = getServiceClients(env);

Deno.serve(createAccountMergeHandler({
  db: clients.db,
  storage: clients.storage,
  authAdmin: clients.authAdmin,
  verifier: getClaimsVerifier(env),
  api: createAppStoreApiFromEnv(env.apple),
  logger: createLogger({}, { level: env.logLevel, pepper: env.logPepper ?? undefined }),
}));
