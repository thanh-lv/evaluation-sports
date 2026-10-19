/**
 * POST /account-merge `{anonAccessToken}` with the permanent account's JWT (DESIGN §6.1, D14).
 *
 * 1. Validate the anonymous token: a valid user JWT with `is_anonymous`, not expired, issued in the last hour.
 * 2. `private.merge_anonymous_account(anon, perm)`: one transaction moving analyses, results, feedback, events, usage
 *    counters (summed, capped; bonus OR-ed), the ledger and the subscription links; it writes the `account_merge`
 *    audit row.
 * 3. Move Storage `{anon}/…` → `{perm}/…` in both buckets, walked recursively.
 * 4. Set App Account Token for every subscription of the permanent account whose Apple token is not yet its uid
 *    (failures are logged; verify-subscription re-points them later).
 * 5. Delete the anonymous auth user, then write an `account_merge_completed` audit row.
 *
 * Idempotent: each step is safe to repeat, and once the anonymous user is gone a repeat answers from the audit log.
 */
import { AccountMergeRequest, type AccountMergeResponse } from '@shared/contracts/index.ts';
import { type ClaimsVerifier, requireUser, verifyAccessToken } from '@shared/auth.ts';
import type { AuthAdmin, Db } from '@shared/db.ts';
import { HttpError, httpError } from '@shared/errors.ts';
import { createRouter, json, parseJson, route } from '@shared/http.ts';
import { errorFields, type Logger } from '@shared/log.ts';
import { BUCKETS, type StorageService } from '@shared/storage.ts';
import type { AppStoreApi } from '@shared/apple/api.ts';
import { normalizeToken } from '@shared/apple/linking.ts';
import { wasMergedInto } from '@shared/apple/services.ts';
import { apiEnvironmentOf } from '@shared/apple/subscriptions.ts';
import type { JwsTransaction } from '@shared/apple/types.ts';

export interface AccountMergeDeps {
  db: Db;
  storage: StorageService;
  authAdmin: AuthAdmin;
  verifier: ClaimsVerifier;
  api: AppStoreApi;
  now?: () => Date;
  logger?: Logger;
}

/** The anonymous token must have been issued at most this long ago. */
export const ANON_TOKEN_MAX_AGE_SEC = 3600;
const CLOCK_SKEW_SEC = 60;

interface MergeResult {
  merged: boolean;
  code?: string;
  analyses?: number;
  subscriptions?: string[];
}

async function verifyAnonToken(deps: AccountMergeDeps, token: string, now: Date): Promise<string> {
  let anon;
  try {
    anon = await verifyAccessToken(token, deps.verifier);
  } catch (err) {
    if (err instanceof HttpError && err.code === 'unauthorized') {
      throw httpError('forbidden', 'invalid anonymous token', { cause: err });
    }
    throw err;
  }
  if (!anon.isAnonymous) throw httpError('forbidden', 'not an anonymous token');
  const iat = Number(anon.claims.iat);
  const t = Math.floor(now.getTime() / 1000);
  if (!Number.isFinite(iat) || iat > t + CLOCK_SKEW_SEC || t - iat > ANON_TOKEN_MAX_AGE_SEC) {
    throw httpError('forbidden', 'anonymous token too old');
  }
  return anon.userId;
}

/** Re-points Apple's appAccountToken of the account's subscriptions; returns [updated, failed]. */
async function repointAppleTokens(deps: AccountMergeDeps, userId: string, log: Logger): Promise<[number, number]> {
  const subs = await deps.db.selectMany<{
    original_transaction_id: string;
    environment: string;
    transaction_info: JwsTransaction | null;
  }>('public', 'app_store_subscriptions', 'original_transaction_id, environment, transaction_info', {
    user_id: userId,
  });
  let updated = 0;
  let failed = 0;
  for (const s of subs) {
    const env = apiEnvironmentOf(s.environment);
    if (!env || normalizeToken(s.transaction_info?.appAccountToken) === userId) continue;
    try {
      await deps.api.setAppAccountToken(env, s.original_transaction_id, userId);
      await deps.db.update('public', 'app_store_subscriptions', {
        transaction_info: { ...(s.transaction_info ?? {}), appAccountToken: userId },
      }, { original_transaction_id: s.original_transaction_id });
      updated++;
    } catch (err) {
      failed++;
      log.warn('set app account token failed', {
        originalTransactionId: s.original_transaction_id,
        ...errorFields(err),
      });
    }
  }
  return [updated, failed];
}

export function createAccountMergeHandler(deps: AccountMergeDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? (() => new Date());
  return createRouter({ fn: 'account-merge', logger: deps.logger }, [
    route('POST', '/', async (req, ctx) => {
      const perm = await requireUser(req, deps.verifier);
      if (perm.isAnonymous) throw httpError('forbidden', 'the target account must be permanent');
      const { anonAccessToken } = await parseJson(req, AccountMergeRequest, { maxBytes: 16 * 1024 });
      const anonId = await verifyAnonToken(deps, anonAccessToken, now());
      if (anonId === perm.userId) throw httpError('invalid_payload', 'same account');

      const anonUser = await deps.authAdmin.getUser(anonId);
      if (!anonUser) {
        // already merged (the anonymous user is deleted last) or never existed
        const merged = await wasMergedInto(deps.db, anonId, perm.userId);
        return json({ merged } satisfies AccountMergeResponse);
      }
      if (!anonUser.isAnonymous) throw httpError('forbidden', 'source account is no longer anonymous');

      const res = await deps.db.rpc<MergeResult>('private', 'merge_anonymous_account', {
        p_from_user_id: anonId,
        p_to_user_id: perm.userId,
      });
      if (!res?.merged) {
        if (res?.code === 'forbidden') throw httpError('forbidden', 'accounts cannot be merged');
        throw httpError('not_found', 'account not found');
      }

      let moved = 0;
      for (const bucket of BUCKETS) {
        moved += await deps.storage.movePrefix(bucket, anonId, perm.userId, { overwrite: true });
      }
      const [tokens, tokenFailures] = await repointAppleTokens(deps, perm.userId, ctx.log);
      await deps.authAdmin.deleteUser(anonId);
      await deps.db.insert('private', 'audit_log', {
        action: 'account_merge_completed',
        subject: perm.userId,
        details: { from: anonId, objectsMoved: moved, appleTokens: tokens, appleTokenFailures: tokenFailures },
      });
      ctx.log.info('account merged', { userId: perm.userId, analyses: res.analyses ?? 0, objects: moved, tokens });
      return json({ merged: true } satisfies AccountMergeResponse);
    }),
  ]);
}
