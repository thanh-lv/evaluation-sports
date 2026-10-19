/**
 * POST /verify-subscription (DESIGN §9.4): StoreKit 2 transaction → Apple's re-fetched state → linking policy →
 * `app_store_subscriptions` + `recompute_entitlement` → `VerifySubscriptionResponse`.
 *
 * Errors: 401 no/invalid JWT; 422 malformed JWS, wrong bundle, unknown transaction; 403 Xcode environment without
 * ALLOW_XCODE_ENV or an untrusted client JWS chain; 409 `linked_to_other_account`; 429 `transfer_rate_limited`;
 * 502 App Store unavailable.
 */
import { VerifySubscriptionRequest } from '@shared/contracts/index.ts';
import { type ClaimsVerifier, requireUser } from '@shared/auth.ts';
import type { AuthAdmin, Db } from '@shared/db.ts';
import type { ServerEnv } from '@shared/env.ts';
import { requireConfig } from '@shared/env.ts';
import { ConfigError, fromRpcFailure, httpError } from '@shared/errors.ts';
import { logServerEvent } from '@shared/events.ts';
import { createRouter, json, parseJson, route } from '@shared/http.ts';
import { errorFields, type Logger } from '@shared/log.ts';
import { type AppStoreApi, toHttpErrorFromApple } from '@shared/apple/api.ts';
import { decodeJws, JwsError, verifyJws } from '@shared/apple/jws.ts';
import { decideLink, normalizeToken, resolveRowOwner, resolveTokenOwner } from '@shared/apple/linking.ts';
import { createOwnerLookup } from '@shared/apple/services.ts';
import {
  apiEnvironmentOf,
  fetchSubscriptionState,
  loadSubscription,
  persistSubscription,
  recomputeEntitlement,
  stateFromXcodeTransaction,
  subscriptionRow,
  type SubscriptionState,
  toVerifyResponse,
} from '@shared/apple/subscriptions.ts';
import type { JwsTransaction } from '@shared/apple/types.ts';

export interface VerifySubscriptionDeps {
  env: Pick<ServerEnv, 'allowXcodeEnv' | 'apple'>;
  db: Db;
  authAdmin: AuthAdmin;
  verifier: ClaimsVerifier;
  api: AppStoreApi;
  roots: () => readonly Uint8Array[];
  now?: () => Date;
  logger?: Logger;
}

const MAX_BODY_BYTES = 32 * 1024;

export function createVerifySubscriptionHandler(deps: VerifySubscriptionDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? (() => new Date());
  return createRouter({ fn: 'verify-subscription', logger: deps.logger }, [
    route('POST', '/', async (req, ctx) => {
      const user = await requireUser(req, deps.verifier);
      const body = await parseJson(req, VerifySubscriptionRequest, { maxBytes: MAX_BODY_BYTES });
      const result = await verifySubscription(deps, user.userId, body, ctx.log, now);
      await logServerEvent(deps.db, {
        name: 'subscription.verified',
        userId: user.userId,
        props: { reason: body.reason, action: result.action, tier: result.response.tier },
      }, ctx.log);
      return json(result.response);
    }),
  ]);
}

async function verifySubscription(
  deps: VerifySubscriptionDeps,
  callerId: string,
  body: VerifySubscriptionRequest,
  log: Logger,
  now: () => Date,
) {
  const bundleId = requireConfig(deps.env.apple.bundleId, 'APPLE_BUNDLE_ID');

  // 1. decode without trust
  let tx: JwsTransaction;
  try {
    tx = decodeJws<JwsTransaction>(body.signedTransaction).payload;
  } catch {
    throw httpError('invalid_payload', 'signedTransaction is not a JWS');
  }
  if (!tx.transactionId || !tx.originalTransactionId) throw httpError('invalid_payload', 'transaction ids missing');
  if (tx.bundleId !== bundleId) throw httpError('invalid_payload', 'bundle id mismatch');

  // 2–3. Xcode bypass (dev project only) or Apple's re-fetched state
  const xcode = tx.environment === 'Xcode';
  let state: SubscriptionState;
  if (xcode) {
    if (!deps.env.allowXcodeEnv) throw httpError('forbidden', 'Xcode environment not accepted');
    state = stateFromXcodeTransaction(tx, now());
  } else {
    const apiEnv = apiEnvironmentOf(tx.environment);
    if (!apiEnv) throw httpError('invalid_payload', 'unknown environment');
    let fetched: SubscriptionState | null;
    try {
      fetched = await fetchSubscriptionState(deps.api, apiEnv, tx.transactionId, tx.originalTransactionId);
    } catch (err) {
      throw toHttpErrorFromApple(err);
    }
    if (!fetched) throw httpError('invalid_payload', 'subscription not found');
    if (fetched.bundleId && fetched.bundleId !== bundleId) throw httpError('invalid_payload', 'bundle id mismatch');
    state = fetched;
  }
  const origTx = state.transaction.originalTransactionId ?? tx.originalTransactionId;

  // 4. linking policy on Apple's token
  const lookup = createOwnerLookup(deps.db, deps.authAdmin);
  const existing = await loadSubscription(deps.db, origTx);
  if (xcode && existing && existing.environment !== 'Xcode') {
    // an unverified local payload must never overwrite or move an App Store (Sandbox/Production) subscription
    throw httpError('forbidden', 'Xcode transaction collides with an App Store subscription');
  }
  const appleToken = normalizeToken(state.transaction.appAccountToken);
  const tokenOwner = await resolveTokenOwner(appleToken, callerId, lookup);
  const rowOwner = await resolveRowOwner(existing?.user_id, callerId, lookup);
  const decision = decideLink({ reason: body.reason, tokenOwner, rowOwner });
  log.info('subscription link decision', { reason: body.reason, tokenOwner, rowOwner, action: decision.action });

  if (decision.action !== 'reject' && decision.verifyChain) {
    if (xcode) {
      log.warn('xcode transaction: client JWS chain not verified');
    } else {
      const roots = deps.roots();
      if (roots.length === 0) throw new ConfigError('missing environment: APPLE_ROOT_CA_G3_PEM');
      try {
        await verifyJws(body.signedTransaction, { roots, now });
      } catch (err) {
        if (err instanceof JwsError) {
          log.warn('client JWS chain rejected', { reason: err.reason });
          throw httpError('forbidden', 'transaction signature not trusted');
        }
        throw err;
      }
    }
  }

  // the other live owner keeps the subscription; make sure our row says so before rejecting / transferring
  const otherOwner = rowOwner === 'other_live' ? existing!.user_id! : tokenOwner === 'other_live' ? appleToken : null;
  const setToken = async () => {
    if (xcode) return;
    try {
      await deps.api.setAppAccountToken(apiEnvironmentOf(state.environment)!, origTx, callerId);
    } catch (err) {
      // the DB link stands; the next verify sees the old token and re-points it again
      log.warn('set app account token failed', errorFields(err));
    }
  };

  let transferred = false;
  if (decision.action === 'reject' || decision.action === 'transfer') {
    const keepLink = rowOwner === 'other_live' ? undefined : { userId: otherOwner };
    await persistSubscription(deps.db, subscriptionRow(state, now(), keepLink));
    if (otherOwner) await recomputeEntitlement(deps.db, otherOwner);
    if (decision.action === 'reject') throw httpError('linked_to_other_account');

    const res = await deps.db.rpc<{ ok: boolean; transferred?: boolean; code?: string }>(
      'private',
      'transfer_subscription',
      { p_original_transaction_id: origTx, p_to_user_id: callerId },
    );
    if (!res?.ok) {
      if (res?.code === 'transfer_rate_limited') throw httpError('transfer_rate_limited');
      throw fromRpcFailure(res ?? {});
    }
    transferred = res.transferred === true;
    await setToken();
  } else {
    await persistSubscription(deps.db, subscriptionRow(state, now(), { userId: callerId }));
    if (rowOwner === 'other_live') await recomputeEntitlement(deps.db, existing!.user_id!);
    if (decision.setToken) await setToken();
  }

  // 5. answer from the recomputed entitlement
  const entitlement = await recomputeEntitlement(deps.db, callerId);
  if (!entitlement) throw new ConfigError('recompute_entitlement returned null (no profile for the caller)');
  return { action: decision.action, response: toVerifyResponse(entitlement, transferred) };
}
