/**
 * Sign in with Apple server calls (DESIGN-v1.0 §6.1 apple-auth-exchange / delete-account, DESIGN §11 5.1.1(v)):
 * - `exchangeCode`: `POST /auth/token` (grant_type=authorization_code) → the refresh token we store encrypted;
 * - `revoke`: `POST /auth/revoke` (token_type_hint=refresh_token) when the account is deleted.
 *
 * The client secret is an ES256 JWT (jwt.ts `siwaClientSecret`), cached for a day. `fetch` is injected for tests.
 */
import type { AppleEnv } from '../env.ts';
import { ConfigError } from '../errors.ts';
import { type FetchLike, fetchWithTimeout } from '../http.ts';
import { cachedToken, siwaClientSecret, type TokenProvider } from './jwt.ts';

export const SIWA_ORIGIN = 'https://appleid.apple.com';
export const SIWA_TIMEOUT_MS = 10_000;

export class SiwaError extends Error {
  readonly status: number;
  /** Apple's `error` field (`invalid_grant`, `invalid_client`, …) when present. */
  readonly error: string | null;
  readonly transient: boolean;
  constructor(message: string, status: number, error: string | null, transient: boolean, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SiwaError';
    this.status = status;
    this.error = error;
    this.transient = transient;
  }
}

export interface SiwaTokens {
  refreshToken: string;
  /** Apple's id token (not verified here: it arrives over TLS from Apple). */
  idToken: string | null;
}

export interface SiwaClient {
  exchangeCode(authorizationCode: string): Promise<SiwaTokens>;
  /** Revokes a refresh token. Apple answers 200 for unknown tokens too, so this is idempotent. */
  revoke(refreshToken: string): Promise<void>;
}

export interface SiwaClientConfig {
  clientId: string;
  clientSecret: TokenProvider;
  fetch?: FetchLike;
  origin?: string;
  timeoutMs?: number;
}

export function createSiwaClient(config: SiwaClientConfig): SiwaClient {
  const doFetch = fetchWithTimeout(config.timeoutMs ?? SIWA_TIMEOUT_MS, config.fetch ?? fetch);
  const origin = config.origin ?? SIWA_ORIGIN;

  async function post(path: string, form: Record<string, string>): Promise<Response> {
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: await config.clientSecret(),
      ...form,
    });
    let res: Response;
    try {
      res = await doFetch(`${origin}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body,
      });
    } catch (err) {
      throw new SiwaError(`siwa ${path} failed`, 0, null, true, err);
    }
    if (res.ok) return res;
    let error: string | null = null;
    try {
      const parsed = (await res.json()) as { error?: unknown };
      if (typeof parsed?.error === 'string') error = parsed.error;
    } catch {
      // not JSON
    }
    throw new SiwaError(
      `siwa ${path} ${res.status}${error ? ` ${error}` : ''}`,
      res.status,
      error,
      res.status === 429 || res.status >= 500,
    );
  }

  return {
    async exchangeCode(authorizationCode) {
      const res = await post('/auth/token', { code: authorizationCode, grant_type: 'authorization_code' });
      let parsed: { refresh_token?: unknown; id_token?: unknown };
      try {
        parsed = await res.json();
      } catch (err) {
        throw new SiwaError('siwa /auth/token returned invalid JSON', res.status, null, true, err);
      }
      if (typeof parsed.refresh_token !== 'string' || parsed.refresh_token === '') {
        throw new SiwaError('siwa /auth/token returned no refresh token', res.status, null, false);
      }
      return {
        refreshToken: parsed.refresh_token,
        idToken: typeof parsed.id_token === 'string' ? parsed.id_token : null,
      };
    },
    async revoke(refreshToken) {
      const res = await post('/auth/revoke', { token: refreshToken, token_type_hint: 'refresh_token' });
      await res.body?.cancel().catch(() => {});
    },
  };
}

/** The real client from env (`APPLE_TEAM_ID`, `APPLE_SIWA_KEY_ID`, `APPLE_SIWA_PRIVATE_KEY`, client id). */
export function createSiwaClientFromEnv(apple: AppleEnv, fetchImpl?: FetchLike): SiwaClient {
  const clientId = apple.siwaClientId ?? '';
  const sign = (now: Date) => {
    if (!apple.teamId || !apple.siwaKeyId || !apple.siwaPrivateKey || !clientId) {
      return Promise.reject(
        new ConfigError(
          'missing environment: APPLE_TEAM_ID, APPLE_SIWA_KEY_ID, APPLE_SIWA_PRIVATE_KEY, APPLE_BUNDLE_ID',
        ),
      );
    }
    return siwaClientSecret({
      teamId: apple.teamId,
      clientId,
      keyId: apple.siwaKeyId,
      privateKey: apple.siwaPrivateKey,
    }, now);
  };
  return createSiwaClient({ clientId, clientSecret: cachedToken(sign, 12 * 3600), fetch: fetchImpl });
}
