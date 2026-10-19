/** Edge Function `delete-account` (DESIGN §6.1, §11); the logic is in handler.ts. */
import { getClaimsVerifier } from '@shared/auth.ts';
import { getServiceClients } from '@shared/db.ts';
import { getEnv } from '@shared/env.ts';
import { createLogger } from '@shared/log.ts';
import { createSiwaClientFromEnv } from '@shared/apple/siwa.ts';
import { createDeleteAccountHandler } from './handler.ts';

const env = getEnv();
const clients = getServiceClients(env);

Deno.serve(createDeleteAccountHandler({
  db: clients.db,
  storage: clients.storage,
  authAdmin: clients.authAdmin,
  verifier: getClaimsVerifier(env),
  siwa: createSiwaClientFromEnv(env.apple),
  tokenEncKey: env.tokenEncKey,
  auditPepper: env.auditPepper,
  logger: createLogger({}, { level: env.logLevel, pepper: env.logPepper ?? undefined }),
}));
