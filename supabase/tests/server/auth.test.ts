/**
 * `_shared/auth.ts`: requireUser with the fake verifier (all branches) and against the running local stack
 * (real ES256 tokens, a locally minted HS256 token, forged tokens), plus requireSecret.
 */
import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import { generateKeyPair, SignJWT } from 'jose';
import {
  bearerToken,
  createClaimsVerifier,
  CRON_SECRET_HEADER,
  INTERNAL_SECRET_HEADER,
  requireSecret,
  requireUser,
  verifyAccessToken,
} from '@shared/auth.ts';
import { ConfigError, HttpError } from '@shared/errors.ts';
import { createRouter, json, route } from '@shared/http.ts';
import { silentLogger } from '@shared/log.ts';
import { assertApiError, buildRequest, FakeClaimsVerifier } from '@shared/testing/index.ts';
import { createAnonymousUser, createTestUser, deleteTestUser, getLocalStack } from '@shared/testing/local_stack.ts';

async function rejectsWith(p: Promise<unknown>, code: string): Promise<HttpError> {
  const err = await assertRejects(() => p, HttpError);
  assertEquals(err.code, code, err.message);
  return err;
}

// ---------------------------------------------------------------------------------------------------------------
// Fake verifier

Deno.test('bearerToken parses the Authorization header', () => {
  assertEquals(bearerToken(buildRequest('/x', { headers: { authorization: 'Bearer abc.def.ghi' } })), 'abc.def.ghi');
  assertEquals(bearerToken(buildRequest('/x', { headers: { authorization: 'bearer   abc.def.ghi ' } })), 'abc.def.ghi');
  assertEquals(bearerToken(buildRequest('/x', { headers: { authorization: 'Basic abc' } })), null);
  assertEquals(bearerToken(buildRequest('/x', { headers: { authorization: 'Bearer a b' } })), null);
  assertEquals(bearerToken(buildRequest('/x')), null);
});

Deno.test('requireUser returns lowercase userId, isAnonymous and the token', async () => {
  const v = new FakeClaimsVerifier();
  const upper = crypto.randomUUID().toUpperCase();
  const token = v.issue({ userId: upper, anonymous: true });
  const user = await requireUser(buildRequest('/x', { token }), v);
  assertEquals(user.userId, upper.toLowerCase());
  assertEquals(user.isAnonymous, true);
  assertEquals(user.token, token);
  assertEquals(user.claims.role, 'authenticated');
  const perm = await requireUser(buildRequest('/x', { token: v.issue() }), v);
  assertEquals(perm.isAnonymous, false);
});

Deno.test('requireUser rejects missing, malformed, unknown, expired and non-user tokens with 401', async () => {
  const v = new FakeClaimsVerifier();
  await rejectsWith(requireUser(buildRequest('/x'), v), 'unauthorized');
  await rejectsWith(requireUser(buildRequest('/x', { token: 'sb_secret_abc' }), v), 'unauthorized');
  await rejectsWith(requireUser(buildRequest('/x', { token: 'a.b.c' }), v), 'unauthorized');
  await rejectsWith(requireUser(buildRequest('/x', { token: v.issue({ ttlSec: -10 }) }), v), 'unauthorized');
  await rejectsWith(requireUser(buildRequest('/x', { token: v.issue({ role: 'service_role' }) }), v), 'unauthorized');
  await rejectsWith(requireUser(buildRequest('/x', { token: v.issue({ role: 'anon' }) }), v), 'unauthorized');
  await rejectsWith(requireUser(buildRequest('/x', { token: v.issue({ userId: 'not-a-uuid' }) }), v), 'unauthorized');
  // the malformed ones never reach the verifier
  assertEquals(v.calls, 5);
});

Deno.test('requireUser maps Auth outages to 502 upstream_unavailable', async () => {
  const v = new FakeClaimsVerifier();
  const token = v.issue();
  v.failWith = { name: 'AuthRetryableFetchError', message: 'fetch failed', status: 0 };
  await rejectsWith(requireUser(buildRequest('/x', { token }), v), 'upstream_unavailable');
  v.failWith = { name: 'AuthApiError', message: 'boom', status: 503 };
  await rejectsWith(requireUser(buildRequest('/x', { token }), v), 'upstream_unavailable');
  v.failWith = null;
  v.throwWith = new TypeError('network');
  await rejectsWith(requireUser(buildRequest('/x', { token }), v), 'upstream_unavailable');
});

Deno.test('requireSecret: constant-time header check; missing server secret is a config error', () => {
  const req = buildRequest('/run', { method: 'POST', headers: { [INTERNAL_SECRET_HEADER]: 's3cret' } });
  requireSecret(req, INTERNAL_SECRET_HEADER, 's3cret');
  const wrong = assertThrows(() => requireSecret(req, INTERNAL_SECRET_HEADER, 's3cret!'), HttpError);
  assertEquals(wrong.code, 'unauthorized');
  assertThrows(() => requireSecret(req, CRON_SECRET_HEADER, 's3cret'), HttpError);
  assertThrows(() => requireSecret(req, INTERNAL_SECRET_HEADER, null), ConfigError);
  assertThrows(() => requireSecret(req, INTERNAL_SECRET_HEADER, ''), ConfigError);
});

Deno.test('router + requireUser/requireSecret: 401 bodies and 500 for an unset secret', async () => {
  const v = new FakeClaimsVerifier();
  const handler = createRouter({ fn: 'analyze', logger: silentLogger }, [
    route('GET', '/me', async (req) => json({ id: (await requireUser(req, v)).userId })),
    route('POST', '/run', (req) => {
      requireSecret(req, INTERNAL_SECRET_HEADER, 'internal');
      return json({ ok: true }, 202);
    }),
    route('POST', '/unset', (req) => {
      requireSecret(req, CRON_SECRET_HEADER, null);
      return json({ ok: true });
    }),
  ]);
  await assertApiError(await handler(buildRequest('/me')), 'unauthorized');
  const id = crypto.randomUUID();
  assertEquals(await (await handler(buildRequest('/me', { token: v.issue({ userId: id }) }))).json(), { id });
  await assertApiError(await handler(buildRequest('/run', { method: 'POST' })), 'unauthorized');
  const ok = await handler(buildRequest('/run', { method: 'POST', headers: { 'x-internal-secret': 'internal' } }));
  assertEquals(ok.status, 202);
  await ok.body?.cancel();
  await assertApiError(await handler(buildRequest('/unset', { method: 'POST' })), 'internal');
});

// ---------------------------------------------------------------------------------------------------------------
// Local stack (skipped when it is not running)

const stack = await getLocalStack();
const live = { ignore: !stack, sanitizeOps: false, sanitizeResources: false };

function b64url(o: unknown): string {
  return btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

Deno.test({
  name: 'local stack: real ES256 access tokens (email user and anonymous user) pass requireUser',
  ...live,
  fn: async () => {
    const verifier = createClaimsVerifier({ supabaseUrl: stack!.url, anonKey: stack!.anonKey });
    const user = await createTestUser(stack!);
    const anon = await createAnonymousUser(stack!);
    try {
      const header = JSON.parse(atob(user.accessToken.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')));
      assertEquals(header.alg, 'ES256', 'local stack signs with asymmetric keys');
      const a = await requireUser(buildRequest('/x', { token: user.accessToken }), verifier);
      assertEquals(a.userId, user.userId.toLowerCase());
      assertEquals(a.isAnonymous, false);
      const b = await requireUser(buildRequest('/x', { token: anon.accessToken }), verifier);
      assertEquals(b.userId, anon.userId);
      assertEquals(b.isAnonymous, true);
    } finally {
      await deleteTestUser(stack!, user.userId);
      await deleteTestUser(stack!, anon.userId);
    }
  },
});

Deno.test({
  name: 'local stack: verification with the injected JWKS (SUPABASE_JWKS) needs no fetch',
  ...live,
  fn: async () => {
    const res = await fetch(`${stack!.url}/auth/v1/.well-known/jwks.json`, { headers: { apikey: stack!.anonKey } });
    const jwks = await res.json();
    const user = await createTestUser(stack!);
    try {
      // a host that cannot be resolved: any JWKS fetch would fail with 502. (supabase-js caches JWKS per storage
      // key, i.e. per first host label, so the host must not be 127.0.0.1 / localhost, which other tests warm.)
      const verifier = createClaimsVerifier({ supabaseUrl: 'http://jwks-only.invalid', anonKey: stack!.anonKey, jwks });
      const a = await verifyAccessToken(user.accessToken, verifier);
      assertEquals(a.userId, user.userId);
    } finally {
      await deleteTestUser(stack!, user.userId);
    }
  },
});

Deno.test({
  name: 'local stack: forged, expired and non-user tokens are rejected with 401',
  ...live,
  fn: async () => {
    const verifier = createClaimsVerifier({ supabaseUrl: stack!.url, anonKey: stack!.anonKey });
    const user = await createTestUser(stack!);
    try {
      const [h, p] = user.accessToken.split('.');
      const claims = JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/')));
      // payload swapped to another subject, original signature kept
      const swapped = `${h}.${b64url({ ...claims, sub: crypto.randomUUID() })}.${user.accessToken.split('.')[2]}`;
      await rejectsWith(verifyAccessToken(swapped, verifier), 'unauthorized');

      // signed with our own P-256 key under the real kid, and under an unknown kid
      const { privateKey } = await generateKeyPair('ES256');
      const kid = JSON.parse(atob(h.replace(/-/g, '+').replace(/_/g, '/'))).kid;
      for (const k of [kid, crypto.randomUUID()]) {
        const forged = await new SignJWT({ ...claims }).setProtectedHeader({ alg: 'ES256', kid: k, typ: 'JWT' })
          .sign(privateKey);
        await rejectsWith(verifyAccessToken(forged, verifier), 'unauthorized');
      }

      // expired (validated before any network call)
      const expired = `${h}.${b64url({ ...claims, exp: 1 })}.${user.accessToken.split('.')[2]}`;
      await rejectsWith(verifyAccessToken(expired, verifier), 'unauthorized');

      // the API keys are not user tokens
      await rejectsWith(verifyAccessToken(stack!.anonKey, verifier), 'unauthorized');
      await rejectsWith(verifyAccessToken(stack!.serviceKey, verifier), 'unauthorized');
    } finally {
      await deleteTestUser(stack!, user.userId);
    }
  },
});

Deno.test({
  name: 'local stack: HS256 token minted with the legacy JWT secret (getClaims → getUser fallback)',
  ...live,
  ignore: !stack?.jwtSecret,
  fn: async () => {
    const verifier = createClaimsVerifier({ supabaseUrl: stack!.url, anonKey: stack!.anonKey });
    const user = await createTestUser(stack!);
    try {
      const now = Math.floor(Date.now() / 1000);
      const mint = (secret: string, sub: string) =>
        new SignJWT({ role: 'authenticated', aud: 'authenticated', is_anonymous: false })
          .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
          .setSubject(sub)
          .setIssuedAt(now)
          .setExpirationTime(now + 600)
          .sign(new TextEncoder().encode(secret));
      // the local Auth still accepts HS256 user tokens signed with the legacy secret (verified via GET /user)
      const good = await verifyAccessToken(await mint(stack!.jwtSecret!, user.userId), verifier);
      assertEquals(good.userId, user.userId);
      assertEquals(good.isAnonymous, false);
      await rejectsWith(
        verifyAccessToken(await mint('wrong-secret-'.repeat(4), user.userId), verifier),
        'unauthorized',
      );
      await rejectsWith(
        verifyAccessToken(await mint(stack!.jwtSecret!, crypto.randomUUID()), verifier),
        'unauthorized',
      );
    } finally {
      await deleteTestUser(stack!, user.userId);
    }
  },
});

Deno.test({
  name: 'local stack: Auth unreachable → 502 upstream_unavailable',
  ...live,
  fn: async () => {
    const user = await createTestUser(stack!);
    try {
      // a fresh JWKS cache key (see above) on a closed port
      const verifier = createClaimsVerifier({ supabaseUrl: 'http://localhost:9', anonKey: stack!.anonKey });
      const err = await rejectsWith(verifyAccessToken(user.accessToken, verifier), 'upstream_unavailable');
      assert(err.status === 502);
    } finally {
      await deleteTestUser(stack!, user.userId);
    }
  },
});
