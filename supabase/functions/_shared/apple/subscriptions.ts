/**
 * Subscription state from Apple → `public.app_store_subscriptions` rows → entitlement (DESIGN §9.4 steps 3 and 5,
 * §9.5 step 4). Shared by verify-subscription, appstore-webhook, account-merge and the daily notification-history
 * task.
 */
import type { VerifySubscriptionResponse } from '@shared/contracts/index.ts';
import type { Db, Row } from '../db.ts';
import { httpError } from '../errors.ts';
import type { AppStoreApi } from './api.ts';
import { decodeJwsPayload } from './jws.ts';
import type { ApiEnvironment, JwsRenewalInfo, JwsTransaction, SubscriptionStatus } from './types.ts';

export interface SubscriptionState {
  environment: 'Production' | 'Sandbox' | 'Xcode';
  status: SubscriptionStatus;
  /** Apple's latest transaction of the subscription. */
  transaction: JwsTransaction;
  renewal: JwsRenewalInfo | null;
  /** `bundleId` of the status response (Apple API) or of the transaction (Xcode). */
  bundleId: string | null;
}

/**
 * `GET /inApps/v1/subscriptions/{transactionId}` and the entry for `originalTransactionId` (or the only entry when
 * it is not given). null when Apple lists no matching subscription.
 */
export async function fetchSubscriptionState(
  api: AppStoreApi,
  environment: ApiEnvironment,
  transactionId: string,
  originalTransactionId?: string | null,
): Promise<SubscriptionState | null> {
  const res = await api.getAllSubscriptionStatuses(environment, transactionId);
  const items = res.data.flatMap((g) => g.lastTransactions ?? []);
  const item = originalTransactionId
    ? items.find((i) => i.originalTransactionId === originalTransactionId)
    : items.length === 1
    ? items[0]
    : undefined;
  if (!item) return null;
  const transaction = decodeJwsPayload<JwsTransaction>(item.signedTransactionInfo);
  const renewal = item.signedRenewalInfo ? decodeJwsPayload<JwsRenewalInfo>(item.signedRenewalInfo) : null;
  return {
    environment: res.environment ?? environment,
    status: item.status,
    transaction,
    renewal,
    bundleId: res.bundleId ?? transaction.bundleId ?? null,
  };
}

/** Xcode StoreKit testing: no Apple API, the decoded client payload is the state (ALLOW_XCODE_ENV only). */
export function stateFromXcodeTransaction(tx: JwsTransaction, now: Date): SubscriptionState {
  const expired = typeof tx.expiresDate === 'number' && tx.expiresDate <= now.getTime();
  return {
    environment: 'Xcode',
    status: tx.revocationDate ? 5 : expired ? 2 : 1,
    transaction: tx,
    renewal: { originalTransactionId: tx.originalTransactionId, autoRenewStatus: expired ? 0 : 1 },
    bundleId: tx.bundleId ?? null,
  };
}

const iso = (ms: number | undefined | null): string | null =>
  typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null;

/** The free trial is the introductory offer (offerType 1) with no paid discount type. */
export function isFreeTrial(tx: JwsTransaction): boolean {
  return tx.offerType === 1 && (tx.offerDiscountType === undefined || tx.offerDiscountType === 'FREE_TRIAL');
}

export interface LinkPatch {
  /** New owner (also written to `app_account_token`); omit to keep the current link. */
  userId: string | null;
}

/** The `app_store_subscriptions` row for a state; `link` changes the owner, otherwise ownership columns are left out. */
export function subscriptionRow(state: SubscriptionState, now: Date, link?: LinkPatch): Row {
  const tx = state.transaction;
  if (!tx.originalTransactionId || !tx.productId) throw httpError('invalid_payload', 'transaction without ids');
  const row: Row = {
    original_transaction_id: tx.originalTransactionId,
    environment: state.environment,
    product_id: tx.productId,
    status: state.status,
    auto_renew: state.renewal?.autoRenewStatus === 1,
    is_trial: isFreeTrial(tx),
    original_purchase_at: iso(tx.originalPurchaseDate),
    period_anchor: iso(tx.purchaseDate) ?? iso(tx.originalPurchaseDate),
    expires_at: iso(tx.expiresDate),
    grace_expires_at: iso(state.renewal?.gracePeriodExpiresDate),
    revoked_at: iso(tx.revocationDate),
    renewal_info: state.renewal,
    transaction_info: tx,
    last_verified_at: now.toISOString(),
  };
  if (link) {
    row.user_id = link.userId;
    row.app_account_token = link.userId;
  }
  return row;
}

export async function persistSubscription(db: Db, row: Row): Promise<void> {
  await db.upsert('public', 'app_store_subscriptions', row, { onConflict: 'original_transaction_id' });
}

export interface StoredSubscription {
  original_transaction_id: string;
  user_id: string | null;
  environment: 'Production' | 'Sandbox' | 'Xcode';
  transaction_info: JwsTransaction | null;
}

export function loadSubscription(db: Db, originalTransactionId: string): Promise<StoredSubscription | null> {
  return db.selectOne<StoredSubscription>(
    'public',
    'app_store_subscriptions',
    'original_transaction_id, user_id, environment, transaction_info',
    { original_transaction_id: originalTransactionId },
  );
}

/** `private.recompute_entitlement(uid)` result. */
export interface EntitlementJson {
  tier: 'free' | 'trial' | 'premium';
  productId: string | null;
  expiresAt: string | null;
  willRenew: boolean;
  inGrace: boolean;
  billingIssue: boolean;
  isTrial: boolean;
}

export async function recomputeEntitlement(db: Db, userId: string): Promise<EntitlementJson | null> {
  return await db.rpc<EntitlementJson | null>('private', 'recompute_entitlement', { p_user_id: userId });
}

export function toVerifyResponse(e: EntitlementJson, transferred: boolean): VerifySubscriptionResponse {
  return {
    tier: e.tier,
    productId: e.productId ?? null,
    expiresAt: e.expiresAt ? new Date(e.expiresAt).toISOString() : null,
    willRenew: e.willRenew === true,
    inGrace: e.inGrace === true,
    billingIssue: e.billingIssue === true,
    isTrial: e.isTrial === true,
    transferred,
  };
}

/** Rows not from Xcode go to Apple's API environment of the same name. */
export function apiEnvironmentOf(env: string | null | undefined): ApiEnvironment | null {
  return env === 'Production' || env === 'Sandbox' ? env : null;
}
