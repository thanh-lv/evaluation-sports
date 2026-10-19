/**
 * Caller authentication for Edge Function routes.
 *
 * - `requireUser(req, verifier)`: validates the `Authorization: Bearer <access token>` with supabase-js
 *   `auth.getClaims()` (2.117.2: verifies asymmetric ES256/RS256 tokens locally against the cached JWKS and falls back
 *   to a `getUser()` round trip for HS256 tokens). Only `role = authenticated` user tokens pass; the anon/service JWTs
 *   and the new `sb_…` API keys are rejected.
 * - `requireSecret(req, header, secret)`: constant-time shared-secret check for `/analyze/run` and `/cron`.
 *
 * The gateway's `verify_jwt` is off for every function (config.toml); this module is the only check.
 * Constant-time comparison comes from crypto.ts.
 */
import { createClient } from '@supabase/supabase-js';
import { LOWER_UUID_RE } from '@shared/contracts/index.ts';
import { ConfigError, httpError } from './errors.ts';
import { getEnv, type ServerEnv } from './env.ts';
import { timingSafeEqual } from './crypto.ts';

/** The claims we rely on (subset of supabase-js `JwtPayload`). */
export interface AccessClaims {
  sub: string;
  role: string;
  exp: number;
  iat: number;
  is_anonymous?: boolean;
  session_id?: string;
  aud?: string | string[];
  [key: string]: unknown;
}

export interface AuthedUser {
  /** `sub`, lower-cased (DESIGN §3: all ids lowercase). */
  userId: string;
  isAnonymous: boolean;
  /** The raw access token (for user-scoped clients). */
  token: string;
  claims: AccessClaims;
}

/** What `requireUser` needs from supabase-js: `client.auth` satisfies it; tests pass a fake. */
export interface ClaimsVerifier {
  getClaims(jwt: string): Promise<{
    data: { claims: Record<string, unknown> } | null;
    error: { name?: string; message: string; status?: number } | null;
  }>;
}

const BEARER_RE = /^Bearer\s+(\S+)\s*$/i;
const JWT_SHAPE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const UUID_ANY_CASE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The bearer token, or null when the header is missing or not `Bearer <token>`. */
export function bearerToken(req: Request): string | null {
  const m = BEARER_RE.exec(req.headers.get('authorization') ?? '');
  return m ? m[1] : null;
}

/** Header names of the shared-secret routes (pg_net sends them; see migrations/…0900_cron.sql). */
export const INTERNAL_SECRET_HEADER = 'x-internal-secret';
export const CRON_SECRET_HEADER = 'x-cron-secret';

type VerifierEnv = Pick<ServerEnv, 'supabaseUrl' | 'anonKey'> & Partial<Pick<ServerEnv, 'jwks'>>;

/**
 * A supabase-js auth client (anon/publishable key, no session). With `env.jwks` (the runtime's `SUPABASE_JWKS`)
 * getClaims verifies without fetching; an unknown `kid` still falls back to the cached JWKS endpoint.
 */
export function createClaimsVerifier(env: VerifierEnv): ClaimsVerifier {
  const client = createClient(env.supabaseUrl, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const jwks = env.jwks ?? undefined;
  return { getClaims: (jwt) => client.auth.getClaims(jwt, jwks ? { jwks } : undefined) };
}

let defaultVerifier: ClaimsVerifier | null = null;

/** The per-worker verifier (one client, one JWKS cache). */
export function getClaimsVerifier(env: VerifierEnv = getEnv()): ClaimsVerifier {
  defaultVerifier ??= createClaimsVerifier(env);
  return defaultVerifier;
}

function isUpstreamFailure(error: { name?: string; status?: number }): boolean {
  // AuthRetryableFetchError (network / 5xx from GoTrue or the JWKS endpoint)
  return error.name === 'AuthRetryableFetchError' || (typeof error.status === 'number' && error.status >= 500);
}

/**
 * Verifies an access token and returns the user. Throws 401 `unauthorized` for a missing, malformed, expired,
 * forged or non-user token, and 502 `upstream_unavailable` when Auth cannot be reached.
 */
export async function verifyAccessToken(token: string, verifier: ClaimsVerifier): Promise<AuthedUser> {
  if (!JWT_SHAPE_RE.test(token)) throw httpError('unauthorized', 'malformed token');
  let result: Awaited<ReturnType<ClaimsVerifier['getClaims']>>;
  try {
    result = await verifier.getClaims(token);
  } catch (err) {
    // getClaims throws (instead of returning) only for non-Auth errors, e.g. a JWKS fetch TypeError
    throw httpError('upstream_unavailable', 'auth unavailable', { cause: err });
  }
  if (result.error) {
    if (isUpstreamFailure(result.error)) {
      throw httpError('upstream_unavailable', 'auth unavailable', { cause: result.error });
    }
    throw httpError('unauthorized', 'invalid token', { cause: result.error });
  }
  const claims = result.data?.claims as AccessClaims | undefined;
  if (!claims) throw httpError('unauthorized', 'invalid token');
  if (claims.role !== 'authenticated') throw httpError('unauthorized', 'not a user token');
  if (typeof claims.sub !== 'string' || !UUID_ANY_CASE_RE.test(claims.sub)) {
    throw httpError('unauthorized', 'invalid subject');
  }
  const userId = claims.sub.toLowerCase();
  if (!LOWER_UUID_RE.test(userId)) throw httpError('unauthorized', 'invalid subject');
  return { userId, isAnonymous: claims.is_anonymous === true, token, claims };
}

/**
 * The authenticated caller (anonymous users included; check `isAnonymous`). Handlers pass their injected verifier;
 * without one the per-worker verifier built from `getEnv()` is used.
 */
export function requireUser(req: Request, verifier?: ClaimsVerifier): Promise<AuthedUser> {
  const token = bearerToken(req);
  if (!token) return Promise.reject(httpError('unauthorized', 'missing bearer token'));
  try {
    return verifyAccessToken(token, verifier ?? getClaimsVerifier());
  } catch (err) {
    return Promise.reject(err);
  }
}

/**
 * Shared-secret check (`x-internal-secret`, `x-cron-secret`). A missing server secret is a configuration error
 * (500, logged), never an open door.
 */
export function requireSecret(req: Request, header: string, secret: string | null | undefined): void {
  if (!secret) throw new ConfigError(`secret for ${header} is not configured`);
  const presented = req.headers.get(header);
  if (presented === null || !timingSafeEqual(presented, secret)) {
    throw httpError('unauthorized', `bad ${header}`);
  }
}
