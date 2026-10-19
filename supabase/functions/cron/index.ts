/** Edge Function `cron` (DESIGN.md §6.1, §6.6); the logic is in handler.ts and `_shared/jobs/daily.ts`. */
import { getServiceClients } from '@shared/db.ts';
import { getEnv } from '@shared/env.ts';
import { createLogger } from '@shared/log.ts';
import { anthropicCoachClient } from '@shared/claude/index.ts';
import { appleServicesFromEnv } from '@shared/apple/services.ts';
import { syncNotificationHistory } from '@shared/apple/notifications.ts';
import { createCronHandler } from './handler.ts';

const env = getEnv();
const clients = getServiceClients(env);
const logger = createLogger({}, { level: env.logLevel, pepper: env.logPepper ?? undefined });
const apple = env.apple;
const appleConfigured = !!(apple.iapKeyId && apple.iapIssuerId && apple.iapPrivateKey && apple.bundleId);

Deno.serve(createCronHandler({
  db: clients.db,
  storage: clients.storage,
  cronSecret: env.cronSecret,
  claudeMode: env.claudeMode,
  warmClient: env.claudeMode === 'live' && env.anthropicApiKey
    ? () => anthropicCoachClient({ apiKey: env.anthropicApiKey! })
    : null,
  syncNotifications: appleConfigured
    ? () => {
      const services = appleServicesFromEnv(env);
      return syncNotificationHistory({
        db: clients.db,
        api: services.api,
        roots: services.roots(),
        bundleId: apple.bundleId,
        log: logger.child({ fn: 'cron', step: 'notification_history' }),
      });
    }
    : null,
  logger,
}));
