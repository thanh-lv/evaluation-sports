/** Edge Function `appstore-webhook` (DESIGN §9.5); the logic is in handler.ts and _shared/apple/notifications.ts. */
import { getServiceClients } from '@shared/db.ts';
import { getEnv } from '@shared/env.ts';
import { createLogger } from '@shared/log.ts';
import { appleServicesFromEnv } from '@shared/apple/services.ts';
import { createWebhookHandler } from './handler.ts';

const env = getEnv();
const apple = appleServicesFromEnv(env);

Deno.serve(createWebhookHandler({
  db: getServiceClients(env).db,
  api: apple.api,
  roots: () => apple.roots(),
  bundleId: env.apple.bundleId,
  logger: createLogger({}, { level: env.logLevel, pepper: env.logPepper ?? undefined }),
}));
