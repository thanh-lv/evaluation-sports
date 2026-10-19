/**
 * POST /apple-auth-exchange `{authorizationCode}` (DESIGN §6.1): exchanges the Sign in with Apple authorization code
 * at `appleid.apple.com/auth/token` and stores the refresh token AES-GCM-encrypted (bound to the user id) in
 * `private.apple_auth_tokens`, so delete-account can revoke it (§11, 5.1.1(v)). Answers 204.
 *
 * Errors: 401 no/invalid JWT; 422 code rejected by Apple (expired, reused, wrong client); 502 Apple unavailable;
 * 500 missing SIWA keys or TOKEN_ENC_KEY.
 */
import { AppleAuthExchangeRequest } from '@shared/contracts/index.ts';
import { type ClaimsVerifier, requireUser } from '@shared/auth.ts';
import { encryptString, importAesKey } from '@shared/crypto.ts';
import type { Db } from '@shared/db.ts';
import { requireConfig } from '@shared/env.ts';
import { HttpError, httpError } from '@shared/errors.ts';
import { createRouter, noContent, parseJson, route } from '@shared/http.ts';
import type { Logger } from '@shared/log.ts';
import { type SiwaClient, SiwaError } from '@shared/apple/siwa.ts';

export interface AppleAuthExchangeDeps {
  db: Db;
  verifier: ClaimsVerifier;
  siwa: SiwaClient;
  tokenEncKey: string | null;
  now?: () => Date;
  logger?: Logger;
}

/** Maps a SIWA failure: transient → 502; `invalid_client` / 401 (our keys) → 500; anything else → 422. */
export function siwaHttpError(err: unknown): unknown {
  if (!(err instanceof SiwaError)) return err;
  if (err.transient) return httpError('upstream_unavailable', 'Apple unavailable', { cause: err });
  if (err.error === 'invalid_client' || err.status === 401) return new HttpError('internal', 'internal error', { cause: err });
  return httpError('invalid_payload', 'authorization code rejected', { cause: err });
}

export function createAppleAuthExchangeHandler(deps: AppleAuthExchangeDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? (() => new Date());
  return createRouter({ fn: 'apple-auth-exchange', logger: deps.logger }, [
    route('POST', '/', async (req, ctx) => {
      const user = await requireUser(req, deps.verifier);
      const { authorizationCode } = await parseJson(req, AppleAuthExchangeRequest, { maxBytes: 8 * 1024 });
      const key = await importAesKey(requireConfig(deps.tokenEncKey, 'TOKEN_ENC_KEY'));
      let refreshToken: string;
      try {
        refreshToken = (await deps.siwa.exchangeCode(authorizationCode)).refreshToken;
      } catch (err) {
        throw siwaHttpError(err);
      }
      const ciphertext = await encryptString(key, refreshToken, user.userId);
      await deps.db.upsert('private', 'apple_auth_tokens', {
        user_id: user.userId,
        ciphertext,
        updated_at: now().toISOString(),
      }, { onConflict: 'user_id' });
      ctx.log.info('siwa refresh token stored', { userId: user.userId });
      return noContent();
    }),
  ]);
}
