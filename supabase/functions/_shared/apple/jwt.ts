/**
 * ES256 tokens for Apple APIs (DESIGN §9.4, DESIGN-v1.0 §6.1), signed with `.p8` keys from App Store Connect:
 * - App Store Server API: header `{alg, kid, typ: JWT}`, claims `{iss: issuerId, iat, exp ≤ 60 min, aud:
 *   'appstoreconnect-v1', bid}`;
 * - Sign in with Apple client secret: header `{alg, kid}`, claims `{iss: teamId, iat, exp ≤ 6 months, aud:
 *   'https://appleid.apple.com', sub: clientId}`;
 * - DeviceCheck: header `{alg, kid}`, claims `{iss: teamId, iat}`.
 *
 * `cachedToken` reuses a token until shortly before it expires, so one worker signs about once per lifetime.
 */
import { importPKCS8, SignJWT } from 'jose';
import { ConfigError } from '../errors.ts';

export type PrivateKeyInput = string | CryptoKey;

const keyCache = new Map<string, Promise<CryptoKey>>();

/** Imports a PKCS#8 PEM (`.p8`) as an ES256 signing key (cached per PEM). */
export function importEs256Key(input: PrivateKeyInput): Promise<CryptoKey> {
  if (typeof input !== 'string') return Promise.resolve(input);
  const pem = input.replace(/\\n/g, '\n').trim();
  let cached = keyCache.get(pem);
  if (!cached) {
    cached = importPKCS8(pem, 'ES256').catch((err) => {
      keyCache.delete(pem);
      throw new ConfigError(`invalid ES256 private key: ${(err as Error).message}`);
    }) as Promise<CryptoKey>;
    keyCache.set(pem, cached);
  }
  return cached;
}

const nowSec = (now: Date) => Math.floor(now.getTime() / 1000);

export interface AppStoreApiKey {
  keyId: string;
  issuerId: string;
  bundleId: string;
  privateKey: PrivateKeyInput;
}

/** Apple caps App Store Server API tokens at 60 minutes. */
export const APP_STORE_TOKEN_TTL_SEC = 20 * 60;

export async function appStoreApiToken(key: AppStoreApiKey, now = new Date(), ttlSec = APP_STORE_TOKEN_TTL_SEC) {
  if (ttlSec <= 0 || ttlSec > 3600) throw new RangeError('App Store token lifetime must be 1..3600 s');
  const iat = nowSec(now);
  return await new SignJWT({ bid: key.bundleId })
    .setProtectedHeader({ alg: 'ES256', kid: key.keyId, typ: 'JWT' })
    .setIssuer(key.issuerId)
    .setIssuedAt(iat)
    .setExpirationTime(iat + ttlSec)
    .setAudience('appstoreconnect-v1')
    .sign(await importEs256Key(key.privateKey));
}

export interface SiwaKey {
  teamId: string;
  /** The app's bundle id (native flow) or Services ID. */
  clientId: string;
  keyId: string;
  privateKey: PrivateKeyInput;
}

export const SIWA_AUDIENCE = 'https://appleid.apple.com';
/** Apple allows up to 6 months; one day is plenty for a cached secret. */
export const SIWA_SECRET_TTL_SEC = 24 * 3600;
const SIX_MONTHS_SEC = 15_777_000;

export async function siwaClientSecret(key: SiwaKey, now = new Date(), ttlSec = SIWA_SECRET_TTL_SEC) {
  if (ttlSec <= 0 || ttlSec > SIX_MONTHS_SEC) throw new RangeError('SIWA client secret lifetime must be ≤ 6 months');
  const iat = nowSec(now);
  return await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: key.keyId })
    .setIssuer(key.teamId)
    .setIssuedAt(iat)
    .setExpirationTime(iat + ttlSec)
    .setAudience(SIWA_AUDIENCE)
    .setSubject(key.clientId)
    .sign(await importEs256Key(key.privateKey));
}

export interface DeviceCheckKey {
  teamId: string;
  keyId: string;
  privateKey: PrivateKeyInput;
}

/** DeviceCheck tokens carry no `exp`; Apple accepts them for up to an hour after `iat`. */
export const DEVICECHECK_TOKEN_REUSE_SEC = 30 * 60;

export async function deviceCheckToken(key: DeviceCheckKey, now = new Date()) {
  return await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: key.keyId })
    .setIssuer(key.teamId)
    .setIssuedAt(nowSec(now))
    .sign(await importEs256Key(key.privateKey));
}

export type TokenProvider = () => Promise<string>;

/**
 * Wraps a signer so the same token is returned until `reuseSec` has passed (keep it well below the token lifetime).
 * A failed signing is not cached.
 */
export function cachedToken(
  sign: (now: Date) => Promise<string>,
  reuseSec: number,
  now = () => new Date(),
): TokenProvider {
  let current: { token: Promise<string>; until: number } | null = null;
  return () => {
    const t = now().getTime();
    if (!current || t >= current.until) {
      const token = sign(new Date(t));
      current = { token, until: t + reuseSec * 1000 };
      token.catch(() => {
        current = null;
      });
    }
    return current.token;
  };
}
