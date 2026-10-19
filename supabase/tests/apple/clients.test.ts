/**
 * `_shared/apple/jwt.ts`, `api.ts`, `siwa.ts`, `devicecheck.ts`: token claims, request shapes (hosts, paths, bodies,
 * auth), error mapping and env overrides, all over an injected fetch.
 */
import { assert, assertEquals, assertRejects } from '@std/assert';
import { decodeProtectedHeader, exportJWK, importJWK, importPKCS8, jwtVerify } from 'jose';
import {
  APP_STORE_TOKEN_TTL_SEC,
  appStoreApiToken,
  cachedToken,
  deviceCheckToken,
  importEs256Key,
  SIWA_AUDIENCE,
  siwaClientSecret,
} from '@shared/apple/jwt.ts';
import { AppleApiError, createAppStoreApi, createAppStoreApiFromEnv, toHttpErrorFromApple } from '@shared/apple/api.ts';
import { createSiwaClient, SiwaError } from '@shared/apple/siwa.ts';
import { createDeviceCheckClient, DeviceCheckError } from '@shared/apple/devicecheck.ts';
import { loadEnv } from '@shared/env.ts';
import { ConfigError, HttpError } from '@shared/errors.ts';
import type { FetchLike } from '@shared/http.ts';
import { envSource, testEnv } from '@shared/testing/index.ts';
import { fixtureText, NOW } from './_apple.ts';

const P8 = fixtureText('test_p8.key.pem');

async function publicKey(): Promise<CryptoKey> {
  const priv = await importPKCS8(P8, 'ES256', { extractable: true });
  const { d: _d, ...jwk } = await exportJWK(priv);
  return (await importJWK(jwk, 'ES256')) as CryptoKey;
}

interface Captured {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

function fakeFetch(respond: (c: Captured) => Response | Promise<Response>): { fetch: FetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetch: FetchLike = async (input, init = {}) => {
    const req = new Request(input, init);
    const c = { url: req.url, method: req.method, headers: req.headers, body: await req.text() };
    calls.push(c);
    return respond(c);
  };
  return { fetch, calls };
}

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// ---------------------------------------------------------------------------------------------------------------
// jwt.ts

Deno.test('appStoreApiToken: ES256, kid/typ header, iss/iat/exp/aud/bid claims, ≤ 60 min', async () => {
  const token = await appStoreApiToken(
    { keyId: 'KEY123', issuerId: 'issuer-uuid', bundleId: 'app.b', privateKey: P8 },
    NOW,
  );
  assertEquals(decodeProtectedHeader(token), { alg: 'ES256', kid: 'KEY123', typ: 'JWT' });
  const { payload } = await jwtVerify(token, await publicKey(), { currentDate: NOW, audience: 'appstoreconnect-v1' });
  assertEquals(payload.iss, 'issuer-uuid');
  assertEquals(payload.bid, 'app.b');
  assertEquals(payload.iat, Math.floor(NOW.getTime() / 1000));
  assertEquals(payload.exp! - payload.iat!, APP_STORE_TOKEN_TTL_SEC);
  await assertRejects(
    () => appStoreApiToken({ keyId: 'k', issuerId: 'i', bundleId: 'b', privateKey: P8 }, NOW, 3601),
    RangeError,
  );
});

Deno.test('siwaClientSecret and deviceCheckToken claims', async () => {
  const secret = await siwaClientSecret({ teamId: 'TEAM', clientId: 'app.b', keyId: 'SIWAKEY', privateKey: P8 }, NOW);
  assertEquals(decodeProtectedHeader(secret), { alg: 'ES256', kid: 'SIWAKEY' });
  const s = await jwtVerify(secret, await publicKey(), { currentDate: NOW, audience: SIWA_AUDIENCE });
  assertEquals([s.payload.iss, s.payload.sub], ['TEAM', 'app.b']);

  const dc = await deviceCheckToken({ teamId: 'TEAM', keyId: 'DCKEY', privateKey: P8 }, NOW);
  assertEquals(decodeProtectedHeader(dc).kid, 'DCKEY');
  const d = await jwtVerify(dc, await publicKey(), { currentDate: NOW });
  assertEquals(d.payload.iss, 'TEAM');
  assertEquals(d.payload.exp, undefined);
});

Deno.test('importEs256Key: one-line \\n PEM accepted, garbage is a ConfigError', async () => {
  await importEs256Key(P8.replace(/\n/g, '\\n'));
  await assertRejects(
    () => importEs256Key('-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----'),
    ConfigError,
  );
});

Deno.test('cachedToken reuses until the reuse window ends and does not cache failures', async () => {
  let t = 0;
  let signs = 0;
  let fail = true;
  const provider = cachedToken(
    (now) => {
      signs++;
      if (fail) return Promise.reject(new Error('boom'));
      return Promise.resolve(`tok-${now.getTime()}`);
    },
    60,
    () => new Date(t),
  );
  await assertRejects(() => provider());
  fail = false;
  assertEquals(await provider(), 'tok-0');
  t = 59_000;
  assertEquals(await provider(), 'tok-0');
  t = 60_000;
  assertEquals(await provider(), 'tok-60000');
  assertEquals(signs, 3);
});

// ---------------------------------------------------------------------------------------------------------------
// api.ts

Deno.test('App Store API: hosts per environment, paths, bearer token, bodies', async () => {
  const { fetch, calls } = fakeFetch((c) => {
    if (c.url.includes('/subscriptions/')) return jsonRes({ environment: 'Sandbox', data: [] });
    if (c.url.includes('/notifications/history')) return jsonRes({ notificationHistory: [], hasMore: false });
    if (c.url.includes('/inApps/v1/transactions/') && c.method === 'GET') {
      return jsonRes({ signedTransactionInfo: 'x' });
    }
    return new Response(null, { status: 200 });
  });
  const api = createAppStoreApi({
    origins: { production: 'https://prod.test', sandbox: 'https://sandbox.test' },
    token: () => Promise.resolve('TOKEN'),
    fetch,
  });
  await api.getAllSubscriptionStatuses('Production', '2000000000000001');
  await api.getAllSubscriptionStatuses('Sandbox', '2000000000000001');
  await api.getTransactionInfo('Sandbox', '2000000000000002');
  await api.setAppAccountToken('Production', '2000000000000001', 'a1b2c3d4-0000-4000-8000-000000000001');
  await api.sendConsumptionInformation('Sandbox', '2000000000000003', {
    customerConsented: true,
    sampleContentProvided: true,
    deliveryStatus: 'DELIVERED',
    consumptionPercentage: 25000,
  });
  await api.getNotificationHistory('Production', { startDate: 1, endDate: 2 }, 'page 2');

  assertEquals(calls.map((c) => `${c.method} ${c.url}`), [
    'GET https://prod.test/inApps/v1/subscriptions/2000000000000001',
    'GET https://sandbox.test/inApps/v1/subscriptions/2000000000000001',
    'GET https://sandbox.test/inApps/v1/transactions/2000000000000002',
    'PUT https://prod.test/inApps/v1/transactions/2000000000000001/appAccountToken',
    'PUT https://sandbox.test/inApps/v2/transactions/consumption/2000000000000003',
    'POST https://prod.test/inApps/v1/notifications/history?paginationToken=page%202',
  ]);
  assert(calls.every((c) => c.headers.get('authorization') === 'Bearer TOKEN'));
  assertEquals(JSON.parse(calls[3].body), { appAccountToken: 'a1b2c3d4-0000-4000-8000-000000000001' });
  assertEquals(JSON.parse(calls[4].body).consumptionPercentage, 25000);
  assertEquals(JSON.parse(calls[5].body), { startDate: 1, endDate: 2 });
});

Deno.test('App Store API: errors are typed (status, errorCode, transient) and mapped to HTTP', async () => {
  let next: () => Response | Promise<Response> = () => jsonRes({ errorCode: 4040010, errorMessage: 'x' }, 404);
  const { fetch } = fakeFetch(() => next());
  const api = createAppStoreApi({
    origins: { production: 'https://p', sandbox: 'https://s' },
    token: () => Promise.resolve('t'),
    fetch,
  });

  let err = await assertRejects(() => api.getAllSubscriptionStatuses('Production', '1'), AppleApiError);
  assertEquals([err.status, err.errorCode, err.transient], [404, 4040010, false]);
  assertEquals((toHttpErrorFromApple(err) as HttpError).code, 'invalid_payload');

  next = () => jsonRes({ errorCode: 4290000 }, 429);
  err = await assertRejects(() => api.getAllSubscriptionStatuses('Production', '1'), AppleApiError);
  assert(err.transient);
  assertEquals((toHttpErrorFromApple(err) as HttpError).code, 'upstream_unavailable');

  next = () => new Response('oops', { status: 503 });
  err = await assertRejects(() => api.getTransactionInfo('Sandbox', '1'), AppleApiError);
  assert(err.transient);

  next = () => new Response(null, { status: 401 });
  err = await assertRejects(() => api.getTransactionInfo('Sandbox', '1'), AppleApiError);
  assertEquals((toHttpErrorFromApple(err) as HttpError).code, 'internal');

  next = () => Promise.reject(new TypeError('network'));
  err = await assertRejects(() => api.getTransactionInfo('Sandbox', '1'), AppleApiError);
  assertEquals([err.status, err.transient], [0, true]);

  next = () => jsonRes({ nodata: true });
  err = await assertRejects(() => api.getAllSubscriptionStatuses('Sandbox', '1'), AppleApiError);
  assert(err.transient);

  // ids are validated before any request
  const bad = await assertRejects(() => api.getTransactionInfo('Sandbox', '../../x'), HttpError);
  assertEquals(bad.code, 'invalid_payload');
  // non-Apple errors pass through untouched
  const other = new Error('x');
  assertEquals(toHttpErrorFromApple(other), other);
});

Deno.test('App Store API from env: hosts overridable, missing IAP key is a ConfigError on first use', async () => {
  const env = loadEnv(envSource({
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_SERVICE_ROLE_KEY: 'svc',
    SUPABASE_ANON_KEY: 'anon',
    APPLE_API_HOST_PROD: 'localhost:9999',
    APPLE_API_HOST_SANDBOX: 'http://127.0.0.1:9998',
  }));
  assertEquals(env.apple.apiOrigin, { production: 'https://localhost:9999', sandbox: 'http://127.0.0.1:9998' });
  const defaults = loadEnv(
    envSource({ SUPABASE_URL: 'http://x', SUPABASE_SERVICE_ROLE_KEY: 's', SUPABASE_ANON_KEY: 'a' }),
  );
  assertEquals(defaults.apple.apiOrigin, {
    production: 'https://api.storekit.apple.com',
    sandbox: 'https://api.storekit-sandbox.apple.com',
  });

  const { fetch, calls } = fakeFetch(() => jsonRes({ data: [] }));
  await assertRejects(
    () => createAppStoreApiFromEnv(testEnv().apple, fetch).getTransactionInfo('Sandbox', '1'),
    ConfigError,
  );
  assertEquals(calls.length, 0);

  const configured = testEnv().apple;
  configured.iapKeyId = 'KEY';
  configured.iapIssuerId = 'ISS';
  configured.iapPrivateKey = P8;
  await createAppStoreApiFromEnv(configured, fetch).getAllSubscriptionStatuses('Sandbox', '1');
  assertEquals(calls[0].url, 'https://apple-sandbox.test/inApps/v1/subscriptions/1');
  const { payload } = await jwtVerify(calls[0].headers.get('authorization')!.slice(7), await publicKey(), {
    audience: 'appstoreconnect-v1',
  });
  assertEquals(payload.bid, 'app.racketcoach.test');
});

// ---------------------------------------------------------------------------------------------------------------
// siwa.ts

Deno.test('SIWA: code exchange and revoke send the client secret form; errors are classified', async () => {
  let next: () => Response = () => jsonRes({ access_token: 'a', refresh_token: 'r-token', id_token: 'id' });
  const { fetch, calls } = fakeFetch(() => next());
  const siwa = createSiwaClient({ clientId: 'app.b', clientSecret: () => Promise.resolve('SECRET'), fetch });

  assertEquals(await siwa.exchangeCode('code-1'), { refreshToken: 'r-token', idToken: 'id' });
  next = () => new Response(null, { status: 200 });
  await siwa.revoke('r-token');
  assertEquals(calls.map((c) => c.url), [
    'https://appleid.apple.com/auth/token',
    'https://appleid.apple.com/auth/revoke',
  ]);
  const form1 = new URLSearchParams(calls[0].body);
  assertEquals(Object.fromEntries(form1), {
    client_id: 'app.b',
    client_secret: 'SECRET',
    code: 'code-1',
    grant_type: 'authorization_code',
  });
  assertEquals(calls[0].headers.get('content-type'), 'application/x-www-form-urlencoded');
  assertEquals(Object.fromEntries(new URLSearchParams(calls[1].body)), {
    client_id: 'app.b',
    client_secret: 'SECRET',
    token: 'r-token',
    token_type_hint: 'refresh_token',
  });

  next = () => jsonRes({ error: 'invalid_grant' }, 400);
  let err = await assertRejects(() => siwa.exchangeCode('used'), SiwaError);
  assertEquals([err.error, err.transient], ['invalid_grant', false]);
  next = () => new Response('busy', { status: 503 });
  err = await assertRejects(() => siwa.revoke('r'), SiwaError);
  assert(err.transient);
  next = () => jsonRes({ access_token: 'a' });
  err = await assertRejects(() => siwa.exchangeCode('c'), SiwaError);
  assertEquals(err.transient, false);
});

// ---------------------------------------------------------------------------------------------------------------
// devicecheck.ts

Deno.test('DeviceCheck: query/update two bits, "bit state not found", error kinds', async () => {
  let next: () => Response = () => new Response('Failed to find bit state', { status: 200 });
  const { fetch, calls } = fakeFetch(() => next());
  const dc = createDeviceCheckClient({
    origin: 'https://api.development.devicecheck.apple.com',
    token: () => Promise.resolve('DCJWT'),
    fetch,
    now: () => NOW,
  });
  assertEquals(await dc.queryTwoBits('dev-token'), { bit0: false, bit1: false, lastUpdateTime: null });
  next = () => jsonRes({ bit0: true, bit1: false, last_update_time: '2026-10' });
  assertEquals(await dc.queryTwoBits('dev-token'), { bit0: true, bit1: false, lastUpdateTime: '2026-10' });
  next = () => new Response(null, { status: 200 });
  await dc.updateTwoBits('dev-token', { bit0: true, bit1: false });

  assertEquals(calls.map((c) => c.url.replace('https://api.development.devicecheck.apple.com', '')), [
    '/v1/query_two_bits',
    '/v1/query_two_bits',
    '/v1/update_two_bits',
  ]);
  const body = JSON.parse(calls[2].body);
  assertEquals([body.device_token, body.bit0, body.bit1, body.timestamp], ['dev-token', true, false, NOW.getTime()]);
  assert(typeof body.transaction_id === 'string');
  assertEquals(calls[0].headers.get('authorization'), 'Bearer DCJWT');

  for (const [status, kind] of [[400, 'invalid_token'], [401, 'config'], [500, 'transient']] as const) {
    next = () => new Response('x', { status });
    const err = await assertRejects(() => dc.queryTwoBits('t'), DeviceCheckError);
    assertEquals(err.kind, kind);
  }
});
