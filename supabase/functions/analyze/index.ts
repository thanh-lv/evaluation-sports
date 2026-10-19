/** Edge Function `analyze` (DESIGN.md §6.1, D12); the logic is in handler.ts. */
import { getClaimsVerifier } from '@shared/auth.ts';
import { getServiceClients } from '@shared/db.ts';
import { getEnv } from '@shared/env.ts';
import { createLogger } from '@shared/log.ts';
import { createDeviceCheckClientFromEnv } from '@shared/apple/devicecheck.ts';
import { InFlightJobs, installShutdownRequeue } from '@shared/jobs/index.ts';
import { coachClientFactory } from './deps.ts';
import { createAnalyzeHandler } from './handler.ts';

const env = getEnv();
const clients = getServiceClients(env);
const logger = createLogger({}, { level: env.logLevel, pepper: env.logPepper ?? undefined });
const inflight = new InFlightJobs();
installShutdownRequeue(inflight, clients.db, logger.child({ fn: 'analyze' }));

const apple = env.apple;
const deviceCheck = apple.teamId && apple.deviceCheckKeyId && apple.deviceCheckPrivateKey
  ? createDeviceCheckClientFromEnv(apple)
  : null;
if (env.claudeMode === 'live' && !env.anthropicApiKey) {
  logger.error('analyze: CLAUDE_MODE is live but ANTHROPIC_API_KEY is not set; analysis jobs will fail', {
    alert: true,
  });
}

Deno.serve(createAnalyzeHandler({
  db: clients.db,
  storage: clients.storage,
  verifier: getClaimsVerifier(env),
  internalSecret: env.internalSecret,
  deviceCheck,
  coachClient: coachClientFactory(env.claudeMode, env.anthropicApiKey),
  logger,
  inflight,
}));
