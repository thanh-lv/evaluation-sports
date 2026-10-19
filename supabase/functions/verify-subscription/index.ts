/** Edge Function `verify-subscription` (DESIGN §9.4); the logic is in handler.ts. */
import { getClaimsVerifier } from '@shared/auth.ts';
import { getServiceClients } from '@shared/db.ts';
import { getEnv } from '@shared/env.ts';
import { createLogger } from '@shared/log.ts';
import { appleServicesFromEnv } from '@shared/apple/services.ts';
import { createVerifySubscriptionHandler } from './handler.ts';

const env = getEnv();
const clients = getServiceClients(env);
const apple = appleServicesFromEnv(env);

Deno.serve(createVerifySubscriptionHandler({
  env,
  db: clients.db,
  authAdmin: clients.authAdmin,
  verifier: getClaimsVerifier(env),
  api: apple.api,
  roots: () => apple.roots(),
  logger: createLogger({}, { level: env.logLevel, pepper: env.logPepper ?? undefined }),
}));
