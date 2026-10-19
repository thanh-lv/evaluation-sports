/** Edge Function `apple-auth-exchange` (DESIGN §6.1); the logic is in handler.ts. */
import { getClaimsVerifier } from '@shared/auth.ts';
import { getServiceClients } from '@shared/db.ts';
import { getEnv } from '@shared/env.ts';
import { createLogger } from '@shared/log.ts';
import { createSiwaClientFromEnv } from '@shared/apple/siwa.ts';
import { createAppleAuthExchangeHandler } from './handler.ts';

const env = getEnv();

Deno.serve(createAppleAuthExchangeHandler({
  db: getServiceClients(env).db,
  verifier: getClaimsVerifier(env),
  siwa: createSiwaClientFromEnv(env.apple),
  tokenEncKey: env.tokenEncKey,
  logger: createLogger({}, { level: env.logLevel, pepper: env.logPepper ?? undefined }),
}));
