/**
 * App Store Server Notifications V2 processing (DESIGN §9.5), shared by `appstore-webhook` and the daily
 * notification-history task (`syncNotificationHistory`, called by `/cron daily` for Production and Sandbox).
 *
 * 1. Decode `signedPayload`; verify its chain when trusted roots are configured (an extra check: no effect below
 *    depends on the payload alone).
 * 2. `INSERT … ON CONFLICT DO NOTHING` into `private.appstore_notifications`; short-circuit only when the stored row
 *    is `processed`, otherwise process again (processing is idempotent).
 * 3. Re-fetch the subscription from Apple and act only on that. REFUND / REVOKE revoke only when the re-fetched
 *    status is 5 or the re-fetched transaction has a `revocationDate` (and is the current period).
 * 4. Upsert, recompute the owner's entitlement, mark `processed`. Transient failures (Apple network/429/5xx,
 *    database) leave the row `failed` and report `retry` (the webhook answers 500 so Apple retries); permanent ones
 *    are marked `failed` and acknowledged.
 *
 * CONSUMPTION_REQUEST: Send Consumption Information only when the owner's `profiles.consumption_consent` is true;
 * otherwise log only.
 */
import type { Db, Row } from '../db.ts';
import { errorFields, type Logger } from '../log.ts';
import { AppleApiError, type AppStoreApi, type ConsumptionRequest } from './api.ts';
import { decodeJws, decodeJwsPayload, JwsError, verifyJws } from './jws.ts';
import { normalizeToken } from './linking.ts';
import {
  apiEnvironmentOf,
  fetchSubscriptionState,
  isFreeTrial,
  loadSubscription,
  persistSubscription,
  recomputeEntitlement,
  subscriptionRow,
} from './subscriptions.ts';
import type { ApiEnvironment, JwsTransaction, NotificationPayload } from './types.ts';

export interface NotificationDeps {
  db: Db;
  api: AppStoreApi;
  /** Trusted roots (DER). Empty → the chain is not verified (logged once per notification). */
  roots: readonly Uint8Array[];
  /** `APPLE_BUNDLE_ID`; notifications for another bundle are acknowledged and ignored. */
  bundleId: string | null;
  log: Logger;
  now?: () => Date;
}

export type NotificationOutcome =
  /** Not a JWS / no notificationUUID. */
  | { outcome: 'malformed' }
  /** Chain verification failed. */
  | { outcome: 'unverified'; reason: string }
  /** Another bundle id or environment we do not handle; not stored. */
  | { outcome: 'ignored'; reason: string }
  | { outcome: 'duplicate'; notificationUUID: string }
  | { outcome: 'processed'; notificationUUID: string; effect: string }
  /** Permanent failure, stored as `failed` and acknowledged. */
  | { outcome: 'failed'; notificationUUID: string; error: string }
  /** Transient failure: ask Apple to retry. */
  | { outcome: 'retry'; notificationUUID: string; error: string };

const REVOKING_TYPES = new Set(['REFUND', 'REVOKE']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class PermanentError extends Error {}

function isTransient(err: unknown): boolean {
  if (err instanceof AppleApiError) return err.transient;
  if (err instanceof PermanentError || err instanceof JwsError) return false;
  return true; // database / network / unknown: retry
}

function decodedForStorage(payload: NotificationPayload): Row {
  const data = payload.data ? { ...payload.data } as Row : undefined;
  if (data) {
    for (const key of ['signedTransactionInfo', 'signedRenewalInfo'] as const) {
      const v = data[key];
      if (typeof v === 'string') {
        try {
          data[key.replace('signed', 'decoded')] = decodeJwsPayload(v);
        } catch {
          // keep the raw value only
        }
        delete data[key];
      }
    }
  }
  return { ...payload, ...(data ? { data } : {}) } as Row;
}

export async function processSignedPayload(deps: NotificationDeps, signedPayload: string): Promise<NotificationOutcome> {
  const now = deps.now ?? (() => new Date());
  let payload: NotificationPayload;
  try {
    payload = decodeJws<NotificationPayload>(signedPayload).payload;
  } catch {
    return { outcome: 'malformed' };
  }
  const uuid = typeof payload.notificationUUID === 'string' ? payload.notificationUUID.toLowerCase() : '';
  if (!UUID_RE.test(uuid) || typeof payload.notificationType !== 'string') return { outcome: 'malformed' };

  if (deps.roots.length > 0) {
    try {
      await verifyJws(signedPayload, { roots: deps.roots, now });
    } catch (err) {
      return { outcome: 'unverified', reason: err instanceof JwsError ? err.reason : 'error' };
    }
  } else {
    deps.log.warn('notification chain not verified: no trusted Apple root configured', { type: payload.notificationType });
  }

  const data = payload.data ?? {};
  if (deps.bundleId && data.bundleId && data.bundleId !== deps.bundleId) {
    return { outcome: 'ignored', reason: 'bundle_mismatch' };
  }

  let tx: JwsTransaction | null = null;
  try {
    tx = data.signedTransactionInfo ? decodeJwsPayload<JwsTransaction>(data.signedTransactionInfo) : null;
  } catch {
    tx = null;
  }

  // 2. inbox row (idempotency)
  const log = deps.log.child({ notification: uuid, type: payload.notificationType, subtype: payload.subtype });
  try {
    await deps.db.upsert('private', 'appstore_notifications', {
      notification_uuid: uuid,
      notification_type: payload.notificationType,
      subtype: payload.subtype ?? null,
      environment: ['Production', 'Sandbox', 'Xcode'].includes(data.environment ?? '') ? data.environment : null,
      original_transaction_id: tx?.originalTransactionId ?? null,
      payload: decodedForStorage(payload),
      status: 'received',
    }, { onConflict: 'notification_uuid', ignoreDuplicates: true });
    const stored = await deps.db.selectOne<{ status: string }>('private', 'appstore_notifications', 'status', {
      notification_uuid: uuid,
    });
    if (stored?.status === 'processed') return { outcome: 'duplicate', notificationUUID: uuid };
  } catch (err) {
    log.error('notification inbox write failed', errorFields(err));
    return { outcome: 'retry', notificationUUID: uuid, error: 'db' };
  }

  // 3–4.
  try {
    const effect = await applyNotification(deps, payload, tx, log, now);
    await deps.db.update('private', 'appstore_notifications', {
      status: 'processed',
      processed_at: now().toISOString(),
      error: null,
    }, { notification_uuid: uuid });
    log.info('notification processed', { effect });
    return { outcome: 'processed', notificationUUID: uuid, effect };
  } catch (err) {
    const transient = isTransient(err);
    const error = err instanceof AppleApiError
      ? `apple_${err.status}${err.errorCode ? `_${err.errorCode}` : ''}`
      : err instanceof PermanentError
      ? err.message
      : 'internal';
    log[transient ? 'error' : 'warn']('notification failed', { transient, error, ...errorFields(err) });
    try {
      await deps.db.update('private', 'appstore_notifications', { status: 'failed', error }, { notification_uuid: uuid });
    } catch (e) {
      log.error('notification status write failed', errorFields(e));
    }
    return transient
      ? { outcome: 'retry', notificationUUID: uuid, error }
      : { outcome: 'failed', notificationUUID: uuid, error };
  }
}

async function profileExists(db: Db, userId: string): Promise<boolean> {
  return (await db.selectOne('public', 'profiles', 'id', { id: userId })) !== null;
}

async function applyNotification(
  deps: NotificationDeps,
  payload: NotificationPayload,
  tx: JwsTransaction | null,
  log: Logger,
  now: () => Date,
): Promise<string> {
  const type = payload.notificationType;
  if (type === 'TEST') return 'test';
  if (!tx?.transactionId || !tx.originalTransactionId) return 'no_transaction';
  const env = apiEnvironmentOf(payload.data?.environment ?? tx.environment);
  if (!env) return 'environment_skipped';

  if (type === 'CONSUMPTION_REQUEST') return await handleConsumptionRequest(deps, env, tx, log, now);

  const state = await fetchSubscriptionState(deps.api, env, tx.transactionId, tx.originalTransactionId);
  if (!state) throw new PermanentError('subscription_not_found');
  if (deps.bundleId && state.bundleId && state.bundleId !== deps.bundleId) throw new PermanentError('bundle_mismatch');

  let revokedAt: string | null = null;
  if (REVOKING_TYPES.has(type)) {
    if (state.status === 5) {
      revokedAt = new Date(state.transaction.revocationDate ?? now().getTime()).toISOString();
    } else {
      // the refunded transaction itself, re-fetched; it revokes only if it is the current period
      const info = await deps.api.getTransactionInfo(env, tx.transactionId);
      const refetched = decodeJwsPayload<JwsTransaction>(info.signedTransactionInfo);
      const current = refetched.transactionId === state.transaction.transactionId ||
        (refetched.expiresDate ?? 0) > now().getTime();
      if (refetched.revocationDate && current) revokedAt = new Date(refetched.revocationDate).toISOString();
    }
  }

  const existing = await loadSubscription(deps.db, tx.originalTransactionId);
  let ownerId = existing?.user_id ?? null;
  let link: { userId: string } | undefined;
  if (!ownerId) {
    // first sight of this subscription (or an unlinked row): Apple's re-fetched token names the purchaser
    const token = normalizeToken(state.transaction.appAccountToken);
    if (token && (await profileExists(deps.db, token))) {
      link = { userId: token };
      ownerId = token;
    }
  }
  const row = subscriptionRow(state, now(), link);
  if (revokedAt && !row.revoked_at) row.revoked_at = revokedAt;
  await persistSubscription(deps.db, row);
  if (ownerId) await recomputeEntitlement(deps.db, ownerId);

  if (revokedAt) {
    await deps.db.insert('private', 'audit_log', {
      action: 'subscription_revoked',
      subject: tx.originalTransactionId,
      details: { type, subtype: payload.subtype ?? null, revocationReason: state.transaction.revocationReason ?? null },
    });
    return 'revoked';
  }
  return REVOKING_TYPES.has(type) ? 'revoke_not_confirmed' : 'refreshed';
}

// ---------------------------------------------------------------------------------------------------------------
// CONSUMPTION_REQUEST

const DAY_MS = 86_400_000;

/**
 * Share of the refunded period's analyses that were used, in thousandths of a percent. Premium windows are the
 * `sub:<origTx>:<YYYY-MM-DD>` counters starting inside [purchaseDate, expiresDate); the trial is `trial:<origTx>`.
 */
export function consumptionPercentage(input: {
  originalTransactionId: string;
  isTrial: boolean;
  purchaseDate: number | undefined;
  expiresDate: number | undefined;
  counters: readonly { period_key: string; used: number }[];
  limits: { trial: number; premium: number };
}): number {
  const { originalTransactionId: otx, counters } = input;
  let used = 0;
  let allowed = 0;
  if (input.isTrial) {
    used = counters.filter((c) => c.period_key === `trial:${otx}`).reduce((s, c) => s + c.used, 0);
    allowed = input.limits.trial;
  } else {
    const from = input.purchaseDate ?? 0;
    const to = input.expiresDate ?? Number.MAX_SAFE_INTEGER;
    const prefix = `sub:${otx}:`;
    for (const c of counters) {
      if (!c.period_key.startsWith(prefix)) continue;
      // window start is an ICT date; compare at day granularity
      const start = Date.parse(`${c.period_key.slice(prefix.length)}T00:00:00+07:00`);
      if (start >= from - DAY_MS && start < to) used += c.used;
    }
    const months = input.purchaseDate && input.expiresDate
      ? Math.max(1, Math.round((input.expiresDate - input.purchaseDate) / (30.44 * DAY_MS)))
      : 1;
    allowed = input.limits.premium * months;
  }
  if (allowed <= 0) return used > 0 ? 100_000 : 0;
  return Math.min(100_000, Math.round((used / allowed) * 100_000));
}

async function handleConsumptionRequest(
  deps: NotificationDeps,
  env: ApiEnvironment,
  tx: JwsTransaction,
  log: Logger,
  now: () => Date,
): Promise<string> {
  const sub = await loadSubscription(deps.db, tx.originalTransactionId!);
  const userId = sub?.user_id ?? null;
  if (!userId) {
    log.info('consumption request: no linked user, not sent');
    return 'consumption_no_user';
  }
  const profile = await deps.db.selectOne<{ consumption_consent: boolean }>(
    'public',
    'profiles',
    'consumption_consent',
    { id: userId },
  );
  if (profile?.consumption_consent !== true) {
    log.info('consumption request: no consent, not sent');
    return 'consumption_no_consent';
  }
  const counters = await deps.db.selectMany<{ period_key: string; used: number }>(
    'public',
    'usage_counters',
    'period_key, used',
    { user_id: userId },
  );
  const limits = await deps.db.selectMany<{ tier: string; total_limit: number }>(
    'public',
    'plan_limits',
    'tier, total_limit',
    {},
  );
  const limitOf = (tier: string) => limits.find((l) => l.tier === tier)?.total_limit ?? 0;
  const body: ConsumptionRequest = {
    customerConsented: true,
    // the free tier gives two analyses a month before any purchase
    sampleContentProvided: true,
    deliveryStatus: 'DELIVERED',
    consumptionPercentage: consumptionPercentage({
      originalTransactionId: tx.originalTransactionId!,
      isTrial: isFreeTrial(tx),
      purchaseDate: tx.purchaseDate,
      expiresDate: tx.expiresDate,
      counters,
      limits: { trial: limitOf('trial'), premium: limitOf('premium') },
    }),
  };
  await deps.api.sendConsumptionInformation(env, tx.transactionId!, body);
  await deps.db.insert('private', 'audit_log', {
    action: 'consumption_sent',
    subject: tx.originalTransactionId,
    details: { consumptionPercentage: body.consumptionPercentage, at: now().toISOString() },
  });
  return 'consumption_sent';
}

// ---------------------------------------------------------------------------------------------------------------
// Notification history (daily cron, DESIGN §9.5 last line)

export interface HistorySyncOptions {
  /** Look-back window (default 26 h). */
  hours?: number;
  environments?: readonly ApiEnvironment[];
  /** Page guard per environment (default 50). */
  maxPages?: number;
}

export interface HistorySyncResult {
  environment: ApiEnvironment;
  fetched: number;
  processed: number;
  duplicates: number;
  failed: number;
  /** Set when listing the history failed (the other environment still runs). */
  error?: string;
}

/**
 * Re-processes every notification Apple sent in the last `hours` on both environments, through the same idempotent
 * path as the webhook (already-processed ones short-circuit). Never throws for a single environment's failure.
 */
export async function syncNotificationHistory(
  deps: NotificationDeps,
  options: HistorySyncOptions = {},
): Promise<HistorySyncResult[]> {
  const now = (deps.now ?? (() => new Date()))().getTime();
  const request = { startDate: now - (options.hours ?? 26) * 3_600_000, endDate: now };
  const results: HistorySyncResult[] = [];
  for (const environment of options.environments ?? (['Production', 'Sandbox'] as const)) {
    const r: HistorySyncResult = { environment, fetched: 0, processed: 0, duplicates: 0, failed: 0 };
    try {
      let token: string | undefined;
      for (let page = 0; page < (options.maxPages ?? 50); page++) {
        const res = await deps.api.getNotificationHistory(environment, request, token);
        for (const item of res.notificationHistory ?? []) {
          r.fetched++;
          const out = await processSignedPayload(deps, item.signedPayload);
          if (out.outcome === 'processed' || out.outcome === 'ignored') r.processed++;
          else if (out.outcome === 'duplicate') r.duplicates++;
          else r.failed++;
        }
        if (!res.hasMore || !res.paginationToken) break;
        token = res.paginationToken;
      }
    } catch (err) {
      r.error = err instanceof AppleApiError ? `apple_${err.status}` : (err as Error).message ?? 'error';
      deps.log.warn('notification history failed', { environment, ...errorFields(err) });
    }
    results.push(r);
  }
  return results;
}

