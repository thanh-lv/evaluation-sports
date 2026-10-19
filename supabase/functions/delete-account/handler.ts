/**
 * POST /delete-account `{confirm: true}` (DESIGN §6.1, §11 5.1.1(v)), for every account type (anonymous too).
 * Every step is idempotent, so a failed request can simply be repeated:
 *
 * 1. Revoke Sign in with Apple with the stored refresh token. Without one, `siwaManualRevoke` is true when the
 *    account uses Apple sign-in (the app then points the user to Settings › Apple ID).
 * 2. Remove `{uid}/` recursively from both buckets (batches of ≤ 1000).
 * 3. Delete the stored token.
 * 4. Null `user_id` and `app_account_token` on the account's subscriptions (Apple billing continues until the user
 *    cancels: `hadActiveSubscription`).
 * 5. `auth.admin.deleteUser` (rows cascade).
 * 6. Audit with `sha256(uid + AUDIT_PEPPER)`; no raw uid is kept.
 */
import { DeleteAccountRequest, type DeleteAccountResponse } from '@shared/contracts/index.ts';
import { type ClaimsVerifier, requireUser } from '@shared/auth.ts';
import { auditSubject, decryptString, importAesKey } from '@shared/crypto.ts';
import type { AuthAdmin, Db } from '@shared/db.ts';
import { requireConfig } from '@shared/env.ts';
import { createRouter, json, parseJson, route } from '@shared/http.ts';
import { errorFields, type Logger } from '@shared/log.ts';
import { BUCKETS, type StorageService } from '@shared/storage.ts';
import { type SiwaClient, SiwaError } from '@shared/apple/siwa.ts';
import { siwaHttpError } from '../apple-auth-exchange/handler.ts';

export interface DeleteAccountDeps {
  db: Db;
  storage: StorageService;
  authAdmin: AuthAdmin;
  verifier: ClaimsVerifier;
  siwa: SiwaClient;
  tokenEncKey: string | null;
  auditPepper: string | null;
  logger?: Logger;
}

type SiwaOutcome = 'revoked' | 'manual' | 'none';

/** Subscription statuses that keep Apple billing alive: active, billing retry, grace. */
const BILLING_STATUSES = new Set([1, 3, 4]);

async function auditExists(db: Db, action: string, subject: string): Promise<{ details: Record<string, unknown> } | null> {
  return await db.selectOne<{ details: Record<string, unknown> }>('private', 'audit_log', 'details', { action, subject });
}

function usesAppleSignIn(claims: Record<string, unknown>): boolean {
  const meta = claims.app_metadata as { provider?: unknown; providers?: unknown } | undefined;
  return meta?.provider === 'apple' || (Array.isArray(meta?.providers) && meta.providers.includes('apple'));
}

async function revokeSiwa(
  deps: DeleteAccountDeps,
  userId: string,
  subject: string,
  claims: Record<string, unknown>,
  log: Logger,
): Promise<SiwaOutcome> {
  const row = await deps.db.selectOne<{ ciphertext: string }>('private', 'apple_auth_tokens', 'ciphertext', {
    user_id: userId,
  });
  if (!row) {
    if (await auditExists(deps.db, 'siwa_revoked', subject)) return 'revoked'; // an earlier run revoked it
    return usesAppleSignIn(claims) ? 'manual' : 'none';
  }
  let refreshToken: string;
  try {
    refreshToken = await decryptString(await importAesKey(requireConfig(deps.tokenEncKey, 'TOKEN_ENC_KEY')), row.ciphertext, userId);
  } catch (err) {
    if ((err as Error).name === 'ConfigError') throw err;
    log.warn('stored siwa token unreadable', errorFields(err)); // e.g. TOKEN_ENC_KEY rotated
    return 'manual';
  }
  try {
    await deps.siwa.revoke(refreshToken);
  } catch (err) {
    if (err instanceof SiwaError && !err.transient) {
      log.warn('siwa revoke rejected', errorFields(err));
      return 'manual';
    }
    throw siwaHttpError(err); // transient: fail now, the user retries
  }
  await deps.db.insert('private', 'audit_log', { action: 'siwa_revoked', subject, details: {} });
  return 'revoked';
}

export function createDeleteAccountHandler(deps: DeleteAccountDeps): (req: Request) => Promise<Response> {
  return createRouter({ fn: 'delete-account', logger: deps.logger }, [
    route('POST', '/', async (req, ctx) => {
      const user = await requireUser(req, deps.verifier);
      await parseJson(req, DeleteAccountRequest, { maxBytes: 1024 });
      const uid = user.userId;
      const subject = await auditSubject(uid, requireConfig(deps.auditPepper, 'AUDIT_PEPPER'));

      // remember whether billing was active before step 4 unlinks it (a repeated request reads it back)
      const subs = await deps.db.selectMany<{ status: number; revoked_at: string | null }>(
        'public',
        'app_store_subscriptions',
        'status, revoked_at',
        { user_id: uid },
      );
      let hadActiveSubscription = subs.some((s) => BILLING_STATUSES.has(Number(s.status)) && !s.revoked_at);
      const started = await auditExists(deps.db, 'account_delete_started', subject);
      if (started) {
        hadActiveSubscription ||= started.details?.hadActiveSubscription === true;
      } else {
        await deps.db.insert('private', 'audit_log', {
          action: 'account_delete_started',
          subject,
          details: { hadActiveSubscription },
        });
      }

      const siwa = await revokeSiwa(deps, uid, subject, user.claims, ctx.log); // 1
      let objectsRemoved = 0;
      for (const bucket of BUCKETS) objectsRemoved += await deps.storage.removePrefix(bucket, uid); // 2
      await deps.db.delete('private', 'apple_auth_tokens', { user_id: uid }); // 3
      await deps.db.update('public', 'app_store_subscriptions', { user_id: null, app_account_token: null }, {
        user_id: uid,
      }); // 4
      const userExisted = await deps.authAdmin.deleteUser(uid); // 5
      if (!(await auditExists(deps.db, 'account_deleted', subject))) {
        await deps.db.insert('private', 'audit_log', {
          action: 'account_deleted',
          subject,
          details: { anonymous: user.isAnonymous, hadActiveSubscription, siwa, objectsRemoved, userExisted },
        }); // 6
      }
      ctx.log.info('account deleted', { siwa, objectsRemoved, userExisted });
      return json({
        deleted: true,
        hadActiveSubscription,
        siwaManualRevoke: siwa === 'manual',
      } satisfies DeleteAccountResponse);
    }),
  ]);
}
