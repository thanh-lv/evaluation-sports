/**
 * POST /appstore-webhook (DESIGN §9.5): App Store Server Notifications V2. No JWT (Apple calls it); the
 * `signedPayload` chain is verified against Apple Root CA G3 (embedded, plus `APPLE_ROOT_CA_G3_PEM`) as an extra
 * check, and every effect comes from Apple's re-fetched state (`_shared/apple/notifications.ts`).
 *
 * Responses: 200 processed / duplicate / ignored / permanent failure (Apple must not retry); 422 malformed;
 * 401 chain rejected; 500 transient failure (Apple retries).
 */
import { z } from 'zod';
import type { Db } from '@shared/db.ts';
import { httpError } from '@shared/errors.ts';
import { createRouter, json, parseJson, route } from '@shared/http.ts';
import type { Logger } from '@shared/log.ts';
import type { AppStoreApi } from '@shared/apple/api.ts';
import { processSignedPayload } from '@shared/apple/notifications.ts';

export interface WebhookDeps {
  db: Db;
  api: AppStoreApi;
  roots: () => readonly Uint8Array[];
  bundleId: string | null;
  now?: () => Date;
  logger?: Logger;
}

const WebhookBody = z.object({ signedPayload: z.string().min(1) });
const MAX_BODY_BYTES = 256 * 1024;

export function createWebhookHandler(deps: WebhookDeps): (req: Request) => Promise<Response> {
  return createRouter({ fn: 'appstore-webhook', logger: deps.logger, cors: false }, [
    route('POST', '/', async (req, ctx) => {
      const { signedPayload } = await parseJson(req, WebhookBody, { maxBytes: MAX_BODY_BYTES });
      const out = await processSignedPayload({
        db: deps.db,
        api: deps.api,
        roots: deps.roots(),
        bundleId: deps.bundleId,
        log: ctx.log,
        now: deps.now,
      }, signedPayload);
      switch (out.outcome) {
        case 'malformed':
          throw httpError('invalid_payload', 'signedPayload is not a notification');
        case 'unverified':
          ctx.log.warn('notification chain rejected', { reason: out.reason });
          throw httpError('unauthorized', 'signature not trusted');
        case 'retry':
          throw httpError('internal', 'transient failure, retry');
        default:
          return json({ ok: true, outcome: out.outcome });
      }
    }),
  ]);
}
