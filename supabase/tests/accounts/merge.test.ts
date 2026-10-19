/**
 * POST /account-merge (DESIGN §6.1, D14) with fakes: anonymous-token validation (is_anonymous, not expired, issued
 * ≤ 1 h), one SQL call for the rows, recursive Storage moves in both buckets, Set App Account Token for moved
 * subscriptions, anonymous user deleted last, audit, and idempotent re-runs.
 */
import { assert, assertEquals } from '@std/assert';
import { AccountMergeResponse } from '@shared/contracts/index.ts';
import { AppleApiError } from '@shared/apple/api.ts';
import { BUCKET_DERIVED, BUCKET_INPUTS } from '@shared/storage.ts';
import { createAccountMergeHandler } from '../../functions/account-merge/handler.ts';
import {
  assertApiError,
  captureLogger,
  createFakeStorage,
  FakeClaimsVerifier,
  jsonRequest,
  readJsonResponse,
} from '@shared/testing/index.ts';
import { FakeAppStoreApi, transaction } from '../apple/_apple.ts';
import { billingDb } from '../apple/_billing_db.ts';

const PERM = 'dddddddd-0000-4000-8000-000000000001';
const ANON = 'dddddddd-0000-4000-8000-000000000002';
// the fake verifier checks `exp` against the real clock, so token times are real too
const nowSec = Math.floor(Date.now() / 1000);

function setup() {
  const b = billingDb();
  b.addUser(PERM);
  b.addUser(ANON, { anonymous: true });
  const { storage, memory } = createFakeStorage({ listPageSize: 50 });
  const api = new FakeAppStoreApi();
  const verifier = new FakeClaimsVerifier();
  const { log, lines } = captureLogger();
  const handler = createAccountMergeHandler({
    db: b.db,
    storage,
    authAdmin: b.authAdmin,
    verifier,
    api,
    logger: log,
  });
  const permToken = verifier.issue({ userId: PERM, iat: nowSec - 30 });
  const anonToken = verifier.issue({ userId: ANON, anonymous: true, iat: nowSec - 600 });
  const call = (anonAccessToken: string, bearer: string = permToken) =>
    handler(jsonRequest('', { anonAccessToken }, { fn: 'account-merge', token: bearer }));
  return { ...b, storage, memory, api, verifier, handler, call, permToken, anonToken, lines };
}

/** Anonymous data: an analysis, an event, files in both buckets, a linked subscription. */
function seedAnon(s: ReturnType<typeof setup>) {
  s.db.seed('public', 'analyses', [{ id: 'a1', user_id: ANON }]);
  s.db.seed('public', 'events', [{ id: 1, user_id: ANON, name: 'app.open' }]);
  for (let i = 1; i <= 5; i++) s.memory.put(BUCKET_INPUTS, `${ANON}/a1/frames/F${i}.jpg`, 'jpg', 'image/jpeg');
  s.memory.put(BUCKET_DERIVED, `${ANON}/a1/pose.raw.json`);
  s.memory.put(BUCKET_DERIVED, `${ANON}/a1/pose.clean.json`);
  s.memory.put(BUCKET_INPUTS, `${PERM}/old/frames/F1.jpg`, 'jpg', 'image/jpeg');
  const tx = transaction({ appAccountToken: ANON });
  s.api.add({ status: 1, tx });
  s.db.seed('public', 'app_store_subscriptions', [{
    original_transaction_id: tx.originalTransactionId,
    user_id: ANON,
    app_account_token: ANON,
    environment: 'Sandbox',
    product_id: tx.productId,
    status: 1,
    expires_at: new Date(tx.expiresDate!).toISOString(),
    transaction_info: tx,
  }]);
  return tx;
}

async function merged(res: Response): Promise<boolean> {
  assertEquals(res.status, 200, await res.clone().text());
  return AccountMergeResponse.parse(await readJsonResponse(res)).merged;
}

Deno.test('merge moves rows (one SQL call), files in both buckets, re-points Apple, deletes the anonymous user', async () => {
  const s = setup();
  const tx = seedAnon(s);
  assertEquals(await merged(await s.call(s.anonToken)), true);

  assertEquals(s.db.callsTo('rpc', 'private.merge_anonymous_account').length, 1);
  assertEquals(s.db.callsTo('rpc', 'private.merge_anonymous_account')[0].args, {
    p_from_user_id: ANON,
    p_to_user_id: PERM,
  });
  assertEquals(s.db.table('public', 'analyses')[0].user_id, PERM);
  assertEquals(s.memory.paths(BUCKET_INPUTS), [
    ...[1, 2, 3, 4, 5].map((i) => `${PERM}/a1/frames/F${i}.jpg`),
    `${PERM}/old/frames/F1.jpg`,
  ]);
  assertEquals(s.memory.paths(BUCKET_DERIVED), [`${PERM}/a1/pose.clean.json`, `${PERM}/a1/pose.raw.json`]);
  assertEquals(s.api.setTokenCalls, [{
    env: 'Sandbox',
    originalTransactionId: tx.originalTransactionId!,
    token: PERM,
  }]);
  assertEquals(
    (s.sub(tx.originalTransactionId!)!.transaction_info as { appAccountToken: string }).appAccountToken,
    PERM,
  );
  assertEquals(s.authAdmin.deleted, [ANON]);
  assertEquals(s.db.table('public', 'entitlements').find((e) => e.user_id === PERM)?.tier, 'premium');
  const done = s.audit('account_merge_completed');
  assertEquals(done.length, 1);
  assertEquals(done[0].details, { from: ANON, objectsMoved: 7, appleTokens: 1, appleTokenFailures: 0 });
});

Deno.test('merge is idempotent: a repeat after success answers merged:true from the audit and does nothing', async () => {
  const s = setup();
  seedAnon(s);
  assertEquals(await merged(await s.call(s.anonToken)), true);
  const rpcs = s.db.callsTo('rpc').length;
  const moves = s.memory.moveCalls.length;
  assertEquals(await merged(await s.call(s.anonToken)), true);
  assertEquals(s.db.callsTo('rpc').length, rpcs);
  assertEquals(s.memory.moveCalls.length, moves);
  assertEquals(s.api.setTokenCalls.length, 1);
});

Deno.test('merge resumes after a partial failure (storage failed before the anonymous user was deleted)', async () => {
  const s = setup();
  seedAnon(s);
  // first attempt: Apple down and the anonymous user deletion fails → 5xx, anon user kept
  const realDelete = s.authAdmin.deleteUser.bind(s.authAdmin);
  s.authAdmin.deleteUser = () => Promise.reject(new Error('auth down'));
  s.api.failSetToken = new AppleApiError('apple api 503', 503, null, true);
  assertEquals((await s.call(s.anonToken)).status, 500);
  assert(s.authAdmin.users.has(ANON));
  // second attempt: everything already moved is skipped; Apple is re-pointed now
  s.authAdmin.deleteUser = realDelete;
  s.api.failSetToken = null;
  s.memory.put(BUCKET_INPUTS, `${ANON}/late/frames/F1.jpg`, 'jpg', 'image/jpeg'); // a straggler upload
  assertEquals(await merged(await s.call(s.anonToken)), true);
  assertEquals(s.memory.paths(BUCKET_INPUTS).filter((p) => p.startsWith(ANON)), []);
  assert(s.memory.paths(BUCKET_INPUTS).includes(`${PERM}/late/frames/F1.jpg`));
  assertEquals(s.api.setTokenCalls.length, 1);
  assertEquals(s.authAdmin.deleted, [ANON]);
});

Deno.test('Set App Account Token failure is logged; the merge still completes', async () => {
  const s = setup();
  seedAnon(s);
  s.api.failSetToken = new AppleApiError('apple api 500', 500, null, true);
  assertEquals(await merged(await s.call(s.anonToken)), true);
  assertEquals(s.audit('account_merge_completed')[0].details, {
    from: ANON,
    objectsMoved: 7,
    appleTokens: 0,
    appleTokenFailures: 1,
  });
  assert(s.lines.some((l) => l.entry.msg === 'set app account token failed'));
});

Deno.test('anonymous token validation: not anonymous, too old, expired, forged → 403', async () => {
  const s = setup();
  const notAnon = s.verifier.issue({ userId: ANON, anonymous: false, iat: nowSec - 60 });
  await assertApiError(await s.call(notAnon), 'forbidden');
  // valid for 3 h but issued 2 h ago
  const old = s.verifier.issue({ userId: ANON, anonymous: true, iat: nowSec - 7200, ttlSec: 3 * 3600 });
  await assertApiError(await s.call(old), 'forbidden');
  const expired = s.verifier.issue({ userId: ANON, anonymous: true, iat: nowSec - 4000, ttlSec: 60 });
  await assertApiError(await s.call(expired), 'forbidden');
  await assertApiError(await s.call('aaa.bbb.ccc'), 'forbidden');
  assertEquals(s.db.callsTo('rpc').length, 0);
});

Deno.test('caller checks: permanent target required, same account refused, auth required', async () => {
  const s = setup();
  const anonCaller = s.verifier.issue({ userId: ANON, anonymous: true, iat: nowSec - 10 });
  await assertApiError(await s.call(s.anonToken, anonCaller), 'forbidden');
  // the "anonymous" token names the caller itself
  const self = s.verifier.issue({ userId: PERM, anonymous: true, iat: nowSec - 10 });
  await assertApiError(await s.call(self), 'invalid_payload');
  await assertApiError(await s.call(s.anonToken, ''), 'unauthorized');
  await assertApiError(
    await s.handler(jsonRequest('', {}, { fn: 'account-merge', token: s.permToken })),
    'invalid_payload',
  );
  // the source is no longer anonymous at Auth (already linked to an identity)
  s.authAdmin.users.get(ANON)!.isAnonymous = false;
  await assertApiError(await s.call(s.anonToken), 'forbidden');
});

Deno.test('an anonymous user that never existed answers merged:false', async () => {
  const s = setup();
  const ghost = s.verifier.issue({ userId: 'dddddddd-0000-4000-8000-00000000000f', anonymous: true, iat: nowSec - 5 });
  assertEquals(await merged(await s.call(ghost)), false);
});
