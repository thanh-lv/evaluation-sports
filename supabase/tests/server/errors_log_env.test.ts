/** `_shared/errors.ts`, `_shared/log.ts` and `_shared/env.ts`. */
import { assert, assertEquals, assertMatch, assertThrows } from '@std/assert';
import { API_ERROR_STATUS, type ApiErrorCode } from '@shared/contracts/index.ts';
import {
  ConfigError,
  fromPostgrestError,
  fromRpcFailure,
  HttpError,
  isApiErrorCode,
  toHttpError,
} from '@shared/errors.ts';
import { createLogger, hashUserId, parseLogLevel, scrubFields, scrubText } from '@shared/log.ts';
import { loadEnv, requireConfig } from '@shared/env.ts';
import { captureLogger, envSource, TEST_TOKEN_ENC_KEY } from '@shared/testing/index.ts';

// ---------------------------------------------------------------------------------------------------------------
// errors

Deno.test('HttpError takes its status from the contracts table for every code', () => {
  for (const [code, status] of Object.entries(API_ERROR_STATUS)) {
    const err = new HttpError(code as ApiErrorCode);
    assertEquals(err.status, status, code);
    assertEquals(err.body.code, code);
  }
});

Deno.test('HttpError body carries message, tips and quota extras only when given', () => {
  assertEquals(new HttpError('not_found').body, { code: 'not_found' });
  const e = new HttpError('quota_exceeded', 'limit', {
    tips: ['upgrade'],
    extra: { limit: 5, used: 5, resetsAt: '2026-11-01T00:00:00+07:00' },
    headers: { 'retry-after': '60' },
  });
  assertEquals(e.body, {
    code: 'quota_exceeded',
    message: 'limit',
    tips: ['upgrade'],
    limit: 5,
    used: 5,
    resetsAt: '2026-11-01T00:00:00+07:00',
  });
  assertEquals(e.headers, { 'retry-after': '60' });
});

Deno.test('toHttpError keeps HttpErrors and hides everything else behind internal', () => {
  const known = new HttpError('forbidden');
  assertEquals(toHttpError(known), known);
  const hidden = toHttpError(new ConfigError('missing environment: X'));
  assertEquals(hidden.code, 'internal');
  assertEquals(hidden.body.message, 'internal error');
  assert(hidden.cause instanceof ConfigError);
  assertEquals(toHttpError('a string').status, 500);
});

Deno.test('fromPostgrestError maps PTnnn + ApiErrorCode, everything else is internal', () => {
  assertEquals(fromPostgrestError({ code: 'PT404', message: 'analysis_not_found' }).status, 404);
  assertEquals(fromPostgrestError({ code: 'PT401', message: 'unauthorized' }).code, 'unauthorized');
  assertEquals(fromPostgrestError({ code: 'PT403', message: 'some free text' }).code, 'internal');
  assertEquals(fromPostgrestError({ code: '23505', message: 'duplicate key' }).code, 'internal');
  assertEquals(fromPostgrestError(null).code, 'internal');
});

Deno.test('fromRpcFailure maps {ok:false, code} results with quota extras', () => {
  const q = fromRpcFailure({ code: 'quota_exceeded', limit: 3, used: 3, resets_at: '2026-11-01T00:00:00+07:00' });
  assertEquals(q.status, 402);
  assertEquals(q.body, { code: 'quota_exceeded', limit: 3, used: 3, resetsAt: '2026-11-01T00:00:00+07:00' });
  assertEquals(fromRpcFailure({ code: 'in_flight' }).status, 429);
  assertEquals(fromRpcFailure({ code: 'not_a_code' }).code, 'internal');
  assert(isApiErrorCode('busy_try_later'));
  assert(!isApiErrorCode('toString'));
});

// ---------------------------------------------------------------------------------------------------------------
// log

Deno.test('log lines are JSON with ts, level, msg and base fields', () => {
  const { log, lines } = captureLogger();
  log.child({ fn: 'analyze', req_id: 'r1' }).info('hello', { ms: 12 });
  const e = lines[0].entry;
  assertEquals([e.level, e.msg, e.fn, e.req_id, e.ms], ['info', 'hello', 'analyze', 'r1', 12]);
  assertMatch(String(e.ts), /^\d{4}-\d{2}-\d{2}T/);
});

Deno.test('log scrubbing: secrets redacted, user ids hashed, emails/JWTs masked, arrays summarised', () => {
  const uid = 'AAAAAAAA-1111-2222-3333-444444444444';
  const { log, lines } = captureLogger();
  log.info('user jane@example.com sent eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.sig', {
    userId: uid,
    to_user_id: uid,
    email: 'jane@example.com',
    access_token: 'tok',
    authorization: 'Bearer x',
    signedTransaction: 'jws',
    kp: [1, 2, 3],
    keypoints: [[1, 2]],
    note: 'contact me at jane@example.com',
    key: 'sb_secret_abcdef123 and sk-ant-api03-xyz',
    coords: Array.from({ length: 50 }, (_, i) => i),
    nested: { email: 'x@y.zz', fine: true, deeper: { a: { b: { c: { d: 1 } } } } },
    input_tokens: 1200,
    model: 'claude-x',
  });
  const raw = lines[0].raw;
  for (const leak of ['jane@example.com', 'eyJhbGci', 'tok"', 'Bearer x', 'sb_secret_abc', 'sk-ant-api03', uid]) {
    assert(!raw.includes(leak), `leaked ${leak}: ${raw}`);
  }
  assert(!raw.toLowerCase().includes(uid.toLowerCase()));
  const e = lines[0].entry as Record<string, unknown>;
  assertEquals(e.user, hashUserId(uid));
  assertEquals(e.user, hashUserId(uid.toLowerCase()), 'hash is case-insensitive');
  assertEquals(e.to_user_id_hash, hashUserId(uid));
  assertEquals(e.email, '[redacted]');
  assertEquals(e.kp, '[redacted]');
  assertEquals(e.coords, '[array(50)]');
  assertEquals(e.input_tokens, 1200);
  assertEquals(e.model, 'claude-x');
  assertEquals((e.nested as Record<string, unknown>).email, '[redacted]');
  assertEquals((e.nested as Record<string, unknown>).fine, true);
  assertMatch(String(e.msg), /\[email\].*\[jwt\]/);
});

Deno.test('log pepper changes the user hash; long text is truncated', () => {
  assert(hashUserId('u', 'p1') !== hashUserId('u', 'p2'));
  assertEquals(hashUserId('u').length, 16);
  assert(scrubText('x'.repeat(2000)).length <= 501);
  assertEquals(scrubFields({ uid: 'abc' }, 'p').user, hashUserId('abc', 'p'));
});

Deno.test('log level filter and parseLogLevel', () => {
  const lines: string[] = [];
  const log = createLogger({}, { level: 'warn', sink: (_l, line) => lines.push(line) });
  log.debug('d');
  log.info('i');
  log.warn('w');
  log.error('e');
  assertEquals(lines.length, 2);
  assertEquals(parseLogLevel('ERROR'), 'error');
  assertEquals(parseLogLevel('verbose'), 'info');
  assertEquals(parseLogLevel(undefined, 'debug'), 'debug');
});

Deno.test('a throwing sink never breaks the caller', () => {
  const log = createLogger({}, {
    sink: () => {
      throw new Error('disk full');
    },
  });
  log.error('still fine');
});

// ---------------------------------------------------------------------------------------------------------------
// env

const BASE = {
  SUPABASE_URL: 'http://kong:8000/',
  SUPABASE_SERVICE_ROLE_KEY: 'legacy-service',
  SUPABASE_ANON_KEY: 'legacy-anon',
};

Deno.test('loadEnv: minimal env, defaults and trailing slash trimmed', () => {
  const env = loadEnv(envSource(BASE));
  assertEquals(env.supabaseUrl, 'http://kong:8000');
  assertEquals(env.serviceKey, 'legacy-service');
  assertEquals(env.anonKey, 'legacy-anon');
  assertEquals(env.claudeMode, 'live'); // mock only when CLAUDE_MODE=mock is explicit
  assertEquals(env.anthropicApiKey, null);
  assertEquals(env.internalSecret, null);
  assertEquals(env.allowXcodeEnv, false);
  assertEquals(env.logLevel, 'info');
  assertEquals(env.jwks, null);
  assertEquals(env.apple.apiOrigin, {
    production: 'https://api.storekit.apple.com',
    sandbox: 'https://api.storekit-sandbox.apple.com',
  });
  assertEquals(env.apple.deviceCheckOrigin, 'https://api.devicecheck.apple.com');
});

Deno.test('loadEnv: new secret/publishable keys (single or JSON map) win over the legacy JWT keys', () => {
  const single = loadEnv(
    envSource({ ...BASE, SUPABASE_SECRET_KEY: 'sb_secret_1', SUPABASE_PUBLISHABLE_KEY: 'sb_pub_1' }),
  );
  assertEquals([single.serviceKey, single.anonKey], ['sb_secret_1', 'sb_pub_1']);
  const maps = loadEnv(envSource({
    ...BASE,
    SUPABASE_SECRET_KEYS: '{"default":"sb_secret_2"}',
    SUPABASE_PUBLISHABLE_KEYS: '{"other":"sb_pub_2"}',
  }));
  assertEquals([maps.serviceKey, maps.anonKey], ['sb_secret_2', 'sb_pub_2']);
  assertThrows(() => loadEnv(envSource({ ...BASE, SUPABASE_SECRET_KEYS: 'not json' })), ConfigError, 'JSON');
});

Deno.test('loadEnv: missing required values are listed in one clear error', () => {
  const err = assertThrows(() => loadEnv(envSource({})), ConfigError);
  assertMatch(err.message, /SUPABASE_URL/);
  assertMatch(err.message, /SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY/);
  assertMatch(err.message, /SUPABASE_PUBLISHABLE_KEY or SUPABASE_ANON_KEY/);
  assertThrows(() => loadEnv(envSource({ ...BASE, SUPABASE_URL: 'not a url' })), ConfigError, 'SUPABASE_URL');
});

Deno.test('loadEnv: CLAUDE_MODE defaults to live (mock only when explicit); explicit live needs a key', () => {
  assertEquals(loadEnv(envSource({ ...BASE, ANTHROPIC_API_KEY: 'sk-ant-x' })).claudeMode, 'live');
  assertEquals(loadEnv(envSource({ ...BASE, ANTHROPIC_API_KEY: 'sk-ant-x', CLAUDE_MODE: 'MOCK' })).claudeMode, 'mock');
  // a missing key never silently switches to the mock generator
  const noKey = loadEnv(envSource({ ...BASE, ANTHROPIC_API_KEY: '  ' }));
  assertEquals(noKey.claudeMode, 'live');
  assertEquals(noKey.anthropicApiKey, null);
  assertEquals(loadEnv(envSource({ ...BASE, CLAUDE_MODE: 'mock' })).claudeMode, 'mock');
  assertThrows(() => loadEnv(envSource({ ...BASE, CLAUDE_MODE: 'live' })), ConfigError, 'ANTHROPIC_API_KEY');
  assertThrows(() => loadEnv(envSource({ ...BASE, CLAUDE_MODE: 'replay' })), ConfigError, 'mock or live');
});

Deno.test('loadEnv: secrets, TOKEN_ENC_KEY validation, booleans, PEM newlines, Apple hosts, JWKS', () => {
  const env = loadEnv(envSource({
    ...BASE,
    INTERNAL_SECRET: 'i',
    CRON_SECRET: 'c',
    TOKEN_ENC_KEY: TEST_TOKEN_ENC_KEY,
    AUDIT_PEPPER: 'p',
    LOG_LEVEL: 'debug',
    ALLOW_XCODE_ENV: 'TRUE',
    APPLE_BUNDLE_ID: 'app.rc',
    APPLE_IAP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
    APPLE_API_HOST_PROD: 'http://127.0.0.1:9999',
    APPLE_API_HOST_SANDBOX: 'mock.apple.test:8443',
    SUPABASE_JWKS: '{"keys":[{"kty":"EC","kid":"k1"}]}',
  }));
  assertEquals([env.internalSecret, env.cronSecret, env.auditPepper, env.logLevel], ['i', 'c', 'p', 'debug']);
  assertEquals(env.allowXcodeEnv, true);
  assertEquals(env.apple.siwaClientId, 'app.rc');
  assertEquals(env.apple.iapPrivateKey, '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----');
  assertEquals(env.apple.apiOrigin.production, 'http://127.0.0.1:9999');
  assertEquals(env.apple.apiOrigin.sandbox, 'https://mock.apple.test:8443');
  assertEquals(env.jwks?.keys[0].kid, 'k1');
  assertEquals(loadEnv(envSource({ ...BASE, SUPABASE_JWKS: 'garbage' })).jwks, null);

  assertThrows(() => loadEnv(envSource({ ...BASE, TOKEN_ENC_KEY: 'c2hvcnQ=' })), ConfigError, '32 bytes');
  assertThrows(() => loadEnv(envSource({ ...BASE, TOKEN_ENC_KEY: '!!!' })), ConfigError, 'base64');
  assertThrows(() => loadEnv(envSource({ ...BASE, ALLOW_XCODE_ENV: 'maybe' })), ConfigError, 'ALLOW_XCODE_ENV');
  assertThrows(
    () => loadEnv(envSource({ ...BASE, APPLE_API_HOST_PROD: 'https://x.test/path' })),
    ConfigError,
    'APPLE_API_HOST_PROD',
  );
});

Deno.test('requireConfig names the missing variable', () => {
  assertEquals(requireConfig('v', 'X'), 'v');
  assertThrows(() => requireConfig(null, 'APPLE_IAP_KEY_ID'), ConfigError, 'APPLE_IAP_KEY_ID');
  assertThrows(() => requireConfig('', 'CRON_SECRET'), ConfigError, 'CRON_SECRET');
});
