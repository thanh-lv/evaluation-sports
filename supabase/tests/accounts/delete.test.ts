/**
 * POST /delete-account (DESIGN §6.1, §11 5.1.1(v)) and POST /apple-auth-exchange with fakes: SIWA revoke or the
 * manual-revoke flag, recursive Storage removal in both buckets in batches of ≤ 1000 (2,500 objects → 3 calls),
 * subscription links nulled, auth user deleted, audit subject sha256(uid + pepper) with no raw uid, idempotent
 * re-runs; the code exchange stores the refresh token encrypted and bound to the user.
 */
import { assert, assertEquals } from '@std/assert';
import { DeleteAccountResponse } from '@shared/contracts/index.ts';
import { auditSubject, decryptString, encryptString, importAesKey } from '@shared/crypto.ts';
import { type SiwaClient, SiwaError, type SiwaTokens } from '@shared/apple/siwa.ts';
import { BUCKET_DERIVED, BUCKET_INPUTS } from '@shared/storage.ts';
import { createDeleteAccountHandler } from '../../functions/delete-account/handler.ts';
import { createAppleAuthExchangeHandler } from '../../functions/apple-auth-exchange/handler.ts';
import {
  assertApiError,
  captureLogger,
  createFakeStorage,
  FakeClaimsVerifier,
  jsonRequest,
  readJsonResponse,
  TEST_TOKEN_ENC_KEY,
} from '@shared/testing/index.ts';
import { billingDb } from '../apple/_billing_db.ts';

const UID = 'eeeeeeee-0000-4000-8000-000000000001';
const OTHER = 'eeeeeeee-0000-4000-8000-000000000002';
const PEPPER = 'pepper-test';

class FakeSiwa implements SiwaClient {
  revoked: string[] = [];
  exchanged: string[] = [];
  failRevoke: Error | null = null;
  failExchange: Error | null = null;
  exchangeCode(code: string): Promise<SiwaTokens> {
    this.exchanged.push(code);
    if (this.failExchange) return Promise.reject(this.failExchange);
    return Promise.resolve({ refreshToken: `refresh-for-${code}`, idToken: null });
  }
  revoke(token: string): Promise<void> {
    if (this.failRevoke) return Promise.reject(this.failRevoke);
    this.revoked.push(token);
    return Promise.resolve();
  }
}

function setup() {
  const b = billingDb();
  b.addUser(UID);
  b.addUser(OTHER);
  const { storage, memory } = createFakeStorage();
  const siwa = new FakeSiwa();
  const verifier = new FakeClaimsVerifier();
  const { log } = captureLogger();
  const handler = createDeleteAccountHandler({
    db: b.db,
    storage,
    authAdmin: b.authAdmin,
    verifier,
    siwa,
    tokenEncKey: TEST_TOKEN_ENC_KEY,
    auditPepper: PEPPER,
    logger: log,
  });
  const exchange = createAppleAuthExchangeHandler({
    db: b.db,
    verifier,
    siwa,
    tokenEncKey: TEST_TOKEN_ENC_KEY,
    logger: log,
  });
  const appleToken = verifier.issue({
    userId: UID,
    extra: { app_metadata: { provider: 'apple', providers: ['apple'] } },
  });
  const call = (token: string = appleToken, body: unknown = { confirm: true }) =>
    handler(jsonRequest('', body, { fn: 'delete-account', token }));
  return { ...b, storage, memory, siwa, verifier, handler, exchange, call, appleToken };
}

async function storeSiwaToken(s: ReturnType<typeof setup>, uid: string, refresh: string) {
  const key = await importAesKey(TEST_TOKEN_ENC_KEY);
  s.db.seed('private', 'apple_auth_tokens', [{ user_id: uid, ciphertext: await encryptString(key, refresh, uid) }]);
}

function seedFiles(s: ReturnType<typeof setup>) {
  // 2,500 frames across nested folders + derived JSON; another user's files must survive
  for (let i = 0; i < 2500; i++) {
    s.memory.put(BUCKET_INPUTS, `${UID}/a${i % 25}/frames/F${i}.jpg`, 'x', 'image/jpeg');
  }
  for (let i = 0; i < 3; i++) s.memory.put(BUCKET_DERIVED, `${UID}/a${i}/pose.raw.json`);
  s.memory.put(BUCKET_INPUTS, `${OTHER}/a/frames/F1.jpg`, 'x', 'image/jpeg');
  s.memory.put(BUCKET_DERIVED, `${OTHER}/a/pose.raw.json`);
}

function seedSubscription(s: ReturnType<typeof setup>, status = 1) {
  s.db.seed('public', 'app_store_subscriptions', [{
    original_transaction_id: '700',
    user_id: UID,
    app_account_token: UID,
    environment: 'Production',
    product_id: 'p',
    status,
    revoked_at: null,
  }]);
}

async function ok(res: Response): Promise<DeleteAccountResponse> {
  assertEquals(res.status, 200, await res.clone().text());
  return DeleteAccountResponse.parse(await readJsonResponse(res));
}

Deno.test('delete: revoke SIWA, remove 2,500 objects in 3 batches, unlink subscriptions, delete user, hashed audit', async () => {
  const s = setup();
  await storeSiwaToken(s, UID, 'r-token');
  seedFiles(s);
  seedSubscription(s);

  const body = await ok(await s.call());
  assertEquals(body, { deleted: true, hadActiveSubscription: true, siwaManualRevoke: false });
  assertEquals(s.siwa.revoked, ['r-token']);
  assertEquals(s.memory.removeCalls.filter((c) => c.bucket === BUCKET_INPUTS).map((c) => c.count), [1000, 1000, 500]);
  assertEquals(s.memory.removeCalls.filter((c) => c.bucket === BUCKET_DERIVED).map((c) => c.count), [3]);
  assertEquals(s.memory.paths(BUCKET_INPUTS), [`${OTHER}/a/frames/F1.jpg`]);
  assertEquals(s.memory.paths(BUCKET_DERIVED), [`${OTHER}/a/pose.raw.json`]);
  assertEquals(s.db.table('private', 'apple_auth_tokens').length, 0);
  const sub = s.sub('700')!;
  assertEquals([sub.user_id, sub.app_account_token], [null, null]);
  assertEquals(s.authAdmin.deleted, [UID]);

  const subject = await auditSubject(UID, PEPPER);
  assertEquals(subject.length, 64);
  const audit = s.audit();
  assertEquals(audit.map((r) => r.action), ['account_delete_started', 'siwa_revoked', 'account_deleted']);
  assert(audit.every((r) => r.subject === subject));
  assert(!JSON.stringify(audit).includes(UID), 'no raw uid in the audit log');
  assertEquals((audit[2].details as Record<string, unknown>).objectsRemoved, 2503);
});

Deno.test('delete is idempotent: a re-run returns the same answer without revoking or auditing twice', async () => {
  const s = setup();
  await storeSiwaToken(s, UID, 'r-token');
  seedFiles(s);
  seedSubscription(s);
  const first = await ok(await s.call());
  const removeCalls = s.memory.removeCalls.length;
  const second = await ok(await s.call()); // same (still valid) access token
  assertEquals(second, first);
  assertEquals(s.siwa.revoked.length, 1);
  assertEquals(s.memory.removeCalls.length, removeCalls, 'nothing left to remove');
  assertEquals(s.audit('account_deleted').length, 1);
  assertEquals(s.audit('account_delete_started').length, 1);
});

Deno.test('delete resumes after a transient SIWA failure (502, nothing deleted), then succeeds', async () => {
  const s = setup();
  await storeSiwaToken(s, UID, 'r-token');
  seedFiles(s);
  s.siwa.failRevoke = new SiwaError('siwa /auth/revoke 503', 503, null, true);
  await assertApiError(await s.call(), 'upstream_unavailable');
  assert(s.authAdmin.users.has(UID));
  assertEquals(s.memory.paths(BUCKET_INPUTS).length, 2501);
  s.siwa.failRevoke = null;
  assertEquals((await ok(await s.call())).siwaManualRevoke, false);
  assertEquals(s.authAdmin.deleted, [UID]);
});

Deno.test('delete: no stored token → siwaManualRevoke only for Apple sign-in accounts; anonymous accounts work', async () => {
  const s = setup();
  assertEquals((await ok(await s.call())).siwaManualRevoke, true);

  const t = setup();
  const anonToken = t.verifier.issue({ userId: UID, anonymous: true });
  const body = await ok(await t.call(anonToken));
  assertEquals(body, { deleted: true, hadActiveSubscription: false, siwaManualRevoke: false });
  assertEquals(t.authAdmin.deleted, [UID]);
  assertEquals(t.siwa.revoked.length, 0);
});

Deno.test('delete: an Apple-rejected revoke (invalid_grant) falls back to manual revoke and continues', async () => {
  const s = setup();
  await storeSiwaToken(s, UID, 'r-token');
  s.siwa.failRevoke = new SiwaError('siwa /auth/revoke 400 invalid_grant', 400, 'invalid_grant', false);
  const body = await ok(await s.call());
  assertEquals(body.siwaManualRevoke, true);
  assertEquals(s.authAdmin.deleted, [UID]);
});

Deno.test('delete: hadActiveSubscription only for billing states (1, 3, 4) that are not revoked', async () => {
  for (const [status, expected] of [[1, true], [3, true], [4, true], [2, false], [5, false]] as const) {
    const s = setup();
    seedSubscription(s, status);
    assertEquals((await ok(await s.call())).hadActiveSubscription, expected, `status ${status}`);
  }
});

Deno.test('delete: confirm must be true; auth required; AUDIT_PEPPER required', async () => {
  const s = setup();
  await assertApiError(await s.call(s.appleToken, { confirm: false }), 'invalid_payload');
  await assertApiError(await s.call(s.appleToken, {}), 'invalid_payload');
  await assertApiError(await s.call(''), 'unauthorized');
  assert(s.authAdmin.users.has(UID));

  const noPepper = createDeleteAccountHandler({
    db: s.db,
    storage: s.storage,
    authAdmin: s.authAdmin,
    verifier: s.verifier,
    siwa: s.siwa,
    tokenEncKey: TEST_TOKEN_ENC_KEY,
    auditPepper: null,
    logger: captureLogger().log,
  });
  const res = await noPepper(jsonRequest('', { confirm: true }, { fn: 'delete-account', token: s.appleToken }));
  await assertApiError(res, 'internal');
  assert(s.authAdmin.users.has(UID));
});

// ---------------------------------------------------------------------------------------------------------------
// apple-auth-exchange

Deno.test('apple-auth-exchange stores the refresh token encrypted and bound to the user (204)', async () => {
  const s = setup();
  const res = await s.exchange(
    jsonRequest('', { authorizationCode: 'code-1' }, { fn: 'apple-auth-exchange', token: s.appleToken }),
  );
  assertEquals(res.status, 204);
  const row = s.db.table('private', 'apple_auth_tokens')[0];
  assertEquals(row.user_id, UID);
  assert(!String(row.ciphertext).includes('refresh-for-code-1'));
  const key = await importAesKey(TEST_TOKEN_ENC_KEY);
  assertEquals(await decryptString(key, String(row.ciphertext), UID), 'refresh-for-code-1');
  // bound to the uid: another user's row cannot reuse it
  let failed = false;
  await decryptString(key, String(row.ciphertext), OTHER).catch(() => failed = true);
  assert(failed);
  // a second sign-in replaces the token (upsert)
  await s.exchange(
    jsonRequest('', { authorizationCode: 'code-2' }, { fn: 'apple-auth-exchange', token: s.appleToken }),
  );
  assertEquals(s.db.table('private', 'apple_auth_tokens').length, 1);
  // and delete-account revokes it
  await ok(await s.call());
  assertEquals(s.siwa.revoked, ['refresh-for-code-2']);
});

Deno.test('apple-auth-exchange error mapping: rejected code 422, Apple down 502, bad client 500, no key 500', async () => {
  const s = setup();
  const post = (body: unknown = { authorizationCode: 'c' }) =>
    s.exchange(jsonRequest('', body, { fn: 'apple-auth-exchange', token: s.appleToken }));
  s.siwa.failExchange = new SiwaError('x', 400, 'invalid_grant', false);
  await assertApiError(await post(), 'invalid_payload');
  s.siwa.failExchange = new SiwaError('x', 503, null, true);
  await assertApiError(await post(), 'upstream_unavailable');
  s.siwa.failExchange = new SiwaError('x', 400, 'invalid_client', false);
  await assertApiError(await post(), 'internal');
  s.siwa.failExchange = null;
  await assertApiError(await post({ authorizationCode: '' }), 'invalid_payload');
  await assertApiError(
    await s.exchange(jsonRequest('', { authorizationCode: 'c' }, { fn: 'apple-auth-exchange' })),
    'unauthorized',
  );
  const noKey = createAppleAuthExchangeHandler({
    db: s.db,
    verifier: s.verifier,
    siwa: s.siwa,
    tokenEncKey: null,
    logger: captureLogger().log,
  });
  await assertApiError(
    await noKey(jsonRequest('', { authorizationCode: 'c' }, { fn: 'apple-auth-exchange', token: s.appleToken })),
    'internal',
  );
  assertEquals(s.db.table('private', 'apple_auth_tokens').length, 0);
});

Deno.test('delete: a re-run after a failure past the revoke does not revoke again (and still reports revoked)', async () => {
  const s = setup();
  await storeSiwaToken(s, UID, 'r-token');
  seedFiles(s);
  const realDelete = s.authAdmin.deleteUser.bind(s.authAdmin);
  let fail = true;
  s.authAdmin.deleteUser = (id: string) => (fail ? Promise.reject(new Error('auth down')) : realDelete(id));
  assertEquals((await s.call()).status, 500);
  assertEquals(s.siwa.revoked, ['r-token']);
  assertEquals(s.db.table('private', 'apple_auth_tokens').length, 0, 'revoked token dropped at once');
  fail = false;
  // Apple would now reject the dead token; it must not be asked again
  s.siwa.failRevoke = new SiwaError('siwa /auth/revoke 400 invalid_grant', 400, 'invalid_grant', false);
  assertEquals((await ok(await s.call())).siwaManualRevoke, false);
  assertEquals(s.siwa.revoked, ['r-token']);
  assertEquals(s.authAdmin.deleted, [UID]);
});

Deno.test('delete: audit rows keyed by the raw uid (e.g. account_merge) are re-keyed to the hash', async () => {
  const s = setup();
  s.db.seed('private', 'audit_log', [
    { action: 'account_merge', subject: UID, details: { from: OTHER } },
    { action: 'account_merge', subject: OTHER, details: {} },
  ]);
  await ok(await s.call());
  const subject = await auditSubject(UID, PEPPER);
  assertEquals(s.audit('account_merge').map((r) => r.subject), [subject, OTHER]);
  assert(!s.audit().some((r) => r.subject === UID));
});
