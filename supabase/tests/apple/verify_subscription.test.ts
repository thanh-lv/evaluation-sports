/**
 * POST /verify-subscription (DESIGN §9.4) with fakes: the linking matrix end to end (caller token, null token with a
 * valid / forged client chain, deleted user, merged anonymous user, other live user → 409 or transfer on restore,
 * transfer rate limit 3/30 days, offer codes), the Xcode bypass flag, and input / Apple failures.
 */
import { assert, assertEquals } from '@std/assert';
import { VerifySubscriptionResponse } from '@shared/contracts/index.ts';
import { AppleApiError } from '@shared/apple/api.ts';
import type { JwsTransaction } from '@shared/apple/types.ts';
import { createVerifySubscriptionHandler } from '../../functions/verify-subscription/handler.ts';
import {
  assertApiError,
  captureLogger,
  FakeClaimsVerifier,
  jsonRequest,
  readJsonResponse,
  testEnv,
} from '@shared/testing/index.ts';
import { DAY_MS, FakeAppStoreApi, NOW, signJws, TEST_ROOTS, transaction } from './_apple.ts';
import { billingDb } from './_billing_db.ts';

const CALLER = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER = 'aaaaaaaa-0000-4000-8000-000000000002';
const DELETED = 'aaaaaaaa-0000-4000-8000-000000000003';
const MERGED_ANON = 'aaaaaaaa-0000-4000-8000-000000000004';

function setup(options: { allowXcode?: boolean } = {}) {
  const b = billingDb();
  b.addUser(CALLER);
  b.addUser(OTHER);
  const api = new FakeAppStoreApi();
  const verifier = new FakeClaimsVerifier();
  const { log, lines } = captureLogger();
  const handler = createVerifySubscriptionHandler({
    env: testEnv({ allowXcodeEnv: options.allowXcode ?? false }),
    db: b.db,
    authAdmin: b.authAdmin,
    verifier,
    api,
    roots: () => TEST_ROOTS,
    now: () => NOW,
    logger: log,
  });
  const token = verifier.issue({ userId: CALLER });
  const call = (signedTransaction: string, reason = 'purchase', bearer: string | undefined = token) =>
    handler(jsonRequest('', { signedTransaction, reason }, { fn: 'verify-subscription', token: bearer }));
  return { ...b, api, verifier, handler, call, lines };
}

/** Apple holds `appleTx` (latest transaction, status 1); the client sends a JWS of `clientTx` (default: the same). */
async function purchase(
  s: ReturnType<typeof setup>,
  appleTx: JwsTransaction,
  options: { status?: 1 | 2 | 3 | 4 | 5; chain?: 'good' | 'rogue'; clientTx?: JwsTransaction } = {},
) {
  s.api.add({ status: options.status ?? 1, tx: appleTx });
  return await signJws(options.clientTx ?? appleTx, { chain: options.chain ?? 'good' });
}

async function okBody(res: Response): Promise<VerifySubscriptionResponse> {
  assertEquals(res.status, 200, await res.clone().text());
  return VerifySubscriptionResponse.parse(await readJsonResponse(res));
}

Deno.test('caller token → link, premium, no Set App Account Token, event logged', async () => {
  const s = setup();
  const tx = transaction({ appAccountToken: CALLER.toUpperCase() });
  const body = await okBody(await s.call(await purchase(s, tx)));
  assertEquals(body.tier, 'premium');
  assertEquals(body.productId, tx.productId);
  assertEquals(body.transferred, false);
  assertEquals(body.willRenew, true);
  assertEquals(body.expiresAt, new Date(tx.expiresDate!).toISOString());
  const row = s.sub(tx.originalTransactionId!)!;
  assertEquals([row.user_id, row.app_account_token, row.environment, row.status], [CALLER, CALLER, 'Sandbox', 1]);
  assertEquals(s.api.setTokenCalls.length, 0);
  assertEquals(s.api.calls[0], { op: 'status', env: 'Sandbox', id: tx.transactionId });
  assertEquals(s.db.table('public', 'events')[0].name, 'subscription.verified');
});

Deno.test('null token (offer code) + valid client chain → link and Set App Account Token to the caller', async () => {
  const s = setup();
  const tx = transaction({ offerType: 3, offerIdentifier: 'LAUNCH' });
  const body = await okBody(await s.call(await purchase(s, tx)));
  assertEquals(body.tier, 'premium');
  assertEquals(s.sub(tx.originalTransactionId!)!.user_id, CALLER);
  assertEquals(s.api.setTokenCalls, [{
    env: 'Sandbox',
    originalTransactionId: tx.originalTransactionId!,
    token: CALLER,
  }]);
});

Deno.test('null token + forged client chain → 403, nothing linked to the caller', async () => {
  const s = setup();
  const tx = transaction();
  const res = await s.call(await purchase(s, tx, { chain: 'rogue' }));
  await assertApiError(res, 'forbidden');
  assertEquals(s.sub(tx.originalTransactionId!), undefined);
  assertEquals(s.api.setTokenCalls.length, 0);
});

Deno.test('trial transaction → tier trial with isTrial', async () => {
  const s = setup();
  const tx = transaction({
    appAccountToken: CALLER,
    productId: 'app.racketcoach.premium.yearly',
    offerType: 1,
    offerDiscountType: 'FREE_TRIAL',
    expiresDate: NOW.getTime() + 7 * DAY_MS,
  });
  const body = await okBody(await s.call(await purchase(s, tx)));
  assertEquals([body.tier, body.isTrial], ['trial', true]);
});

Deno.test('token of a deleted user → verified link + Set App Account Token', async () => {
  const s = setup();
  const tx = transaction({ appAccountToken: DELETED });
  s.db.seed('public', 'app_store_subscriptions', [{
    original_transaction_id: tx.originalTransactionId,
    user_id: null,
    app_account_token: null,
    environment: 'Sandbox',
    product_id: tx.productId,
    status: 1,
  }]);
  const body = await okBody(await s.call(await purchase(s, tx), 'restore'));
  assertEquals([body.tier, body.transferred], ['premium', false]);
  assertEquals(s.sub(tx.originalTransactionId!)!.user_id, CALLER);
  assertEquals(s.api.setTokenCalls.map((c) => c.token), [CALLER]);
});

Deno.test('token of an anonymous user merged into the caller → link (audit account_merge)', async () => {
  const s = setup();
  s.db.seed('private', 'audit_log', [{ action: 'account_merge', subject: CALLER, details: { from: MERGED_ANON } }]);
  const tx = transaction({ appAccountToken: MERGED_ANON });
  const body = await okBody(await s.call(await purchase(s, tx), 'launch'));
  assertEquals(body.tier, 'premium');
  assertEquals(s.api.setTokenCalls.map((c) => c.token), [CALLER]);
});

Deno.test('token of another live user → 409 linked_to_other_account for purchase/launch/update; row kept by them', async () => {
  for (const reason of ['purchase', 'launch', 'update']) {
    const s = setup();
    const tx = transaction({ appAccountToken: OTHER });
    const res = await s.call(await purchase(s, tx), reason);
    await assertApiError(res, 'linked_to_other_account');
    assertEquals(s.sub(tx.originalTransactionId!)!.user_id, OTHER, reason);
    assertEquals(s.db.table('public', 'entitlements').find((e) => e.user_id === OTHER)?.tier, 'premium');
    assertEquals(s.api.setTokenCalls.length, 0);
  }
});

Deno.test('token of another live user + restore → transfer, both recomputed, Set App Account Token, transferred:true', async () => {
  const s = setup();
  const tx = transaction({ appAccountToken: OTHER });
  const jws = await purchase(s, tx);
  const body = await okBody(await s.call(jws, 'restore'));
  assertEquals([body.tier, body.transferred], ['premium', true]);
  assertEquals(s.sub(tx.originalTransactionId!)!.user_id, CALLER);
  assertEquals(s.db.table('public', 'entitlements').find((e) => e.user_id === OTHER)?.tier, 'free');
  assertEquals(s.api.setTokenCalls.map((c) => c.token), [CALLER]);
  assertEquals(s.audit('subscription_transfer').length, 1);
  // a later launch sync sees Apple's token = caller and simply links
  const again = await okBody(await s.call(jws, 'launch'));
  assertEquals(again.transferred, false);
});

Deno.test('restore transfers are rate-limited to 3 per 30 days (429 transfer_rate_limited)', async () => {
  const s = setup();
  const tx = transaction({ appAccountToken: OTHER });
  const jws = await purchase(s, tx);
  const otherToken = s.verifier.issue({ userId: OTHER });
  // ping-pong between the two accounts: 3 transfers succeed, the 4th is refused
  const owners = [CALLER, OTHER, CALLER];
  for (const [i, owner] of owners.entries()) {
    const res = await s.call(jws, 'restore', owner === CALLER ? undefined : otherToken);
    assertEquals((await okBody(res)).transferred, true, `transfer ${i + 1}`);
  }
  const res = await s.call(jws, 'restore', otherToken);
  await assertApiError(res, 'transfer_rate_limited');
  assertEquals(s.sub(tx.originalTransactionId!)!.user_id, CALLER);
});

Deno.test('restore transfer requires a valid client chain', async () => {
  const s = setup();
  const tx = transaction({ appAccountToken: OTHER });
  await assertApiError(await s.call(await purchase(s, tx, { chain: 'rogue' }), 'restore'), 'forbidden');
  assertEquals(s.sub(tx.originalTransactionId!)?.user_id ?? OTHER, OTHER);
  assertEquals(s.audit('subscription_transfer').length, 0);
});

Deno.test('our row linked to the caller wins over a stale Apple token: link and re-point', async () => {
  const s = setup();
  const tx = transaction({ appAccountToken: OTHER });
  s.db.seed('public', 'app_store_subscriptions', [{
    original_transaction_id: tx.originalTransactionId,
    user_id: CALLER,
    app_account_token: CALLER,
    environment: 'Sandbox',
    product_id: tx.productId,
    status: 1,
  }]);
  const body = await okBody(await s.call(await purchase(s, tx), 'launch'));
  assertEquals([body.tier, body.transferred], ['premium', false]);
  assertEquals(s.api.setTokenCalls.map((c) => c.token), [CALLER]);
});

Deno.test('Apple is the source of truth: the client payload cannot claim a token or status', async () => {
  const s = setup();
  // Apple: expired, token of another user; client JWS claims the caller's token
  const appleTx = transaction({ appAccountToken: OTHER, expiresDate: NOW.getTime() - DAY_MS });
  const res = await s.call(
    await purchase(s, appleTx, { status: 2, clientTx: { ...appleTx, appAccountToken: CALLER } }),
    'launch',
  );
  await assertApiError(res, 'linked_to_other_account');
  assertEquals(s.sub(appleTx.originalTransactionId!)!.status, 2);
});

Deno.test('Set App Account Token failure does not fail the request (the link stands)', async () => {
  const s = setup();
  s.api.failSetToken = new AppleApiError('apple api 500', 500, null, true);
  const tx = transaction();
  const body = await okBody(await s.call(await purchase(s, tx)));
  assertEquals(body.tier, 'premium');
  assert(s.lines.some((l) => l.entry.msg === 'set app account token failed'));
});

Deno.test('Xcode environment: 403 without ALLOW_XCODE_ENV; with it, no Apple call and the decoded payload is used', async () => {
  const tx = transaction({ environment: 'Xcode', appAccountToken: CALLER });
  const jws = await signJws(tx, { chain: 'rogue' }); // Xcode transactions are signed by a local test certificate
  const off = setup();
  await assertApiError(await off.call(jws), 'forbidden');
  assertEquals(off.api.calls.length, 0);

  const on = setup({ allowXcode: true });
  const body = await okBody(await on.call(jws));
  assertEquals(body.tier, 'premium');
  assertEquals(on.api.calls.length, 0);
  assertEquals(on.sub(tx.originalTransactionId!)!.environment, 'Xcode');
  assertEquals(on.db.table('public', 'entitlements')[0]?.tier ?? 'premium', 'premium');
});

Deno.test('input and upstream failures', async () => {
  const s = setup();
  await assertApiError(await s.call('not-a-jws'), 'invalid_payload');
  await assertApiError(await s.call(await signJws(transaction({ bundleId: 'com.evil' }))), 'invalid_payload');
  await assertApiError(await s.call(await signJws(transaction({ environment: undefined }))), 'invalid_payload');
  await assertApiError(await s.call(await signJws(transaction()), 'nope'), 'invalid_payload');
  // unknown to Apple
  await assertApiError(await s.call(await signJws(transaction())), 'invalid_payload');
  // Apple down
  const tx = transaction({ appAccountToken: CALLER });
  const jws = await purchase(s, tx);
  s.api.failNext = new AppleApiError('apple api 503', 503, null, true);
  await assertApiError(await s.call(jws), 'upstream_unavailable');
  // no / bad JWT
  await assertApiError(await s.call(jws, 'purchase', ''), 'unauthorized');
  await assertApiError(await s.call(jws, 'purchase', 'a.b.c'), 'unauthorized');
});

Deno.test('adversarial: an Xcode payload cannot overwrite or move an App Store subscription (even with the flag)', async () => {
  const s = setup({ allowXcode: true });
  const tx = transaction({ appAccountToken: OTHER });
  s.db.seed('public', 'app_store_subscriptions', [{
    original_transaction_id: tx.originalTransactionId,
    user_id: OTHER,
    app_account_token: OTHER,
    environment: 'Sandbox',
    product_id: tx.productId,
    status: 1,
  }]);
  const forged = {
    ...tx,
    environment: 'Xcode' as const,
    appAccountToken: CALLER,
    expiresDate: NOW.getTime() + 999 * DAY_MS,
  };
  for (const reason of ['purchase', 'restore']) {
    await assertApiError(await s.call(await signJws(forged, { chain: 'rogue' }), reason), 'forbidden');
  }
  const row = s.sub(tx.originalTransactionId!)!;
  assertEquals([row.user_id, row.environment, row.status], [OTHER, 'Sandbox', 1]);
  assertEquals(s.audit('subscription_transfer').length, 0);
  assertEquals(s.api.calls.length, 0);
});

Deno.test('adversarial: null Apple token while another live user holds our row → 409 unless restore (chain checked)', async () => {
  const s = setup();
  const tx = transaction(); // offer code: no appAccountToken at Apple
  s.db.seed('public', 'app_store_subscriptions', [{
    original_transaction_id: tx.originalTransactionId,
    user_id: OTHER,
    app_account_token: OTHER,
    environment: 'Sandbox',
    product_id: tx.productId,
    status: 1,
  }]);
  const jws = await purchase(s, tx);
  for (const reason of ['purchase', 'launch', 'update']) {
    await assertApiError(await s.call(jws, reason), 'linked_to_other_account');
  }
  assertEquals(s.sub(tx.originalTransactionId!)!.user_id, OTHER);
  // restore with a forged chain is refused before anything moves
  await assertApiError(await s.call(await signJws(tx, { chain: 'rogue' }), 'restore'), 'forbidden');
  assertEquals(s.sub(tx.originalTransactionId!)!.user_id, OTHER);
  assertEquals(s.api.setTokenCalls.length, 0);
  // restore with Apple-signed proof transfers
  assertEquals((await okBody(await s.call(jws, 'restore'))).transferred, true);
  assertEquals(s.sub(tx.originalTransactionId!)!.user_id, CALLER);
});
