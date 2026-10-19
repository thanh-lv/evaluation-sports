/**
 * POST /appstore-webhook and `_shared/apple/notifications.ts` (DESIGN §9.5): chain check, insert-on-conflict
 * idempotency (short-circuit only when processed), effects only from Apple's re-fetched state (a REFUND without a
 * re-fetched status 5 / revocationDate is a no-op), CONSUMPTION_REQUEST gated by consent, transient → 500, and the
 * daily notification-history helper on both environments.
 */
import { assert, assertEquals } from '@std/assert';
import { AppleApiError } from '@shared/apple/api.ts';
import { consumptionPercentage, syncNotificationHistory } from '@shared/apple/notifications.ts';
import type { JwsTransaction } from '@shared/apple/types.ts';
import { createWebhookHandler } from '../../functions/appstore-webhook/handler.ts';
import { assertApiError, captureLogger, jsonRequest, readJsonResponse } from '@shared/testing/index.ts';
import { BUNDLE_ID, DAY_MS, FakeAppStoreApi, notification, NOW, signJws, TEST_ROOTS, transaction } from './_apple.ts';
import { billingDb } from './_billing_db.ts';

const OWNER = 'bbbbbbbb-0000-4000-8000-000000000001';

function setup() {
  const b = billingDb();
  b.addUser(OWNER);
  const api = new FakeAppStoreApi();
  const { log, lines } = captureLogger();
  const handler = createWebhookHandler({
    db: b.db,
    api,
    roots: () => TEST_ROOTS,
    bundleId: BUNDLE_ID,
    now: () => NOW,
    logger: log,
  });
  const post = (signedPayload: unknown) => handler(jsonRequest('', { signedPayload }, { fn: 'appstore-webhook' }));
  const inbox = () => b.db.table('private', 'appstore_notifications');
  return { ...b, api, handler, post, inbox, lines, log };
}

/** A linked premium subscription in our DB and at Apple. */
function linkedSubscription(s: ReturnType<typeof setup>, overrides: Partial<JwsTransaction> = {}) {
  const tx = transaction({ appAccountToken: OWNER, ...overrides });
  s.api.add({ status: 1, tx });
  s.db.seed('public', 'app_store_subscriptions', [{
    original_transaction_id: tx.originalTransactionId,
    user_id: OWNER,
    app_account_token: OWNER,
    environment: 'Sandbox',
    product_id: tx.productId,
    status: 1,
    expires_at: new Date(tx.expiresDate!).toISOString(),
    revoked_at: null,
  }]);
  return tx;
}

async function outcome(res: Response): Promise<string> {
  assertEquals(res.status, 200, await res.clone().text());
  return (await readJsonResponse<{ outcome: string }>(res)).outcome;
}

const tierOf = (s: ReturnType<typeof setup>, uid: string) =>
  s.db.table('public', 'entitlements').find((e) => e.user_id === uid)?.tier;

Deno.test('DID_RENEW: re-fetched from Apple, upserted, entitlement recomputed, inbox row processed', async () => {
  const s = setup();
  const tx = linkedSubscription(s);
  const renewed = { ...tx, transactionId: '2999', expiresDate: NOW.getTime() + 60 * DAY_MS };
  s.api.subs.get(tx.originalTransactionId!)!.tx = renewed;
  const n = notification('DID_RENEW', renewed);
  assertEquals(await outcome(await s.post(await signJws(n))), 'processed');
  assertEquals(s.sub(tx.originalTransactionId!)!.expires_at, new Date(renewed.expiresDate).toISOString());
  assertEquals(tierOf(s, OWNER), 'premium');
  const row = s.inbox()[0];
  assertEquals([row.notification_uuid, row.status, row.notification_type], [
    n.notificationUUID,
    'processed',
    'DID_RENEW',
  ]);
  assertEquals(row.original_transaction_id, tx.originalTransactionId);
  // the stored payload keeps decoded transaction info, not the raw JWS
  assert(!JSON.stringify(row.payload).includes('signedTransactionInfo'));
});

Deno.test('duplicate delivery of a processed notification short-circuits (no Apple call, no writes)', async () => {
  const s = setup();
  const tx = linkedSubscription(s);
  const jws = await signJws(notification('DID_RENEW', tx));
  assertEquals(await outcome(await s.post(jws)), 'processed');
  const appleCalls = s.api.calls.length;
  const upserts = s.db.callsTo('upsert', 'public.app_store_subscriptions').length;
  assertEquals(await outcome(await s.post(jws)), 'duplicate');
  assertEquals(s.api.calls.length, appleCalls);
  assertEquals(s.db.callsTo('upsert', 'public.app_store_subscriptions').length, upserts);
  assertEquals(s.inbox().length, 1);
});

Deno.test('a stored but unprocessed notification (failed earlier) is processed again', async () => {
  const s = setup();
  const tx = linkedSubscription(s);
  const jws = await signJws(notification('DID_CHANGE_RENEWAL_STATUS', tx));
  s.api.failNext = new AppleApiError('apple api 503', 503, null, true);
  await assertApiError(await s.post(jws), 'internal'); // 500 → Apple retries
  assertEquals(s.inbox()[0].status, 'failed');
  assertEquals(await outcome(await s.post(jws)), 'processed');
  assertEquals(s.inbox()[0].status, 'processed');
});

Deno.test('REFUND without a re-fetched status 5 or revocationDate is a no-op (nobody downgraded)', async () => {
  const s = setup();
  const tx = linkedSubscription(s);
  // the payload claims a refund with a revocation date; Apple's re-fetched state says active, not revoked
  const claimed = { ...tx, revocationDate: NOW.getTime() - 1000, revocationReason: 0 };
  assertEquals(await outcome(await s.post(await signJws(notification('REFUND', claimed)))), 'processed');
  const row = s.sub(tx.originalTransactionId!)!;
  assertEquals([row.status, row.revoked_at], [1, null]);
  assertEquals(tierOf(s, OWNER), 'premium');
  assertEquals(s.audit('subscription_revoked').length, 0);
  assertEquals(s.api.callsOf('transaction'), 1, 'the refunded transaction is re-fetched too');
});

Deno.test('REFUND confirmed by Apple (status 5) revokes, recomputes to free and audits', async () => {
  const s = setup();
  const tx = linkedSubscription(s);
  const revoked = { ...tx, revocationDate: NOW.getTime() - 1000, revocationReason: 0 };
  s.api.subs.get(tx.originalTransactionId!)!.status = 5;
  s.api.subs.get(tx.originalTransactionId!)!.tx = revoked;
  assertEquals(await outcome(await s.post(await signJws(notification('REFUND', revoked)))), 'processed');
  const row = s.sub(tx.originalTransactionId!)!;
  assertEquals(row.status, 5);
  assertEquals(row.revoked_at, new Date(revoked.revocationDate).toISOString());
  assertEquals(tierOf(s, OWNER), 'free');
  assertEquals(s.audit('subscription_revoked').length, 1);
});

Deno.test('REVOKE confirmed by a revocationDate on the re-fetched current transaction (status still 1)', async () => {
  const s = setup();
  const tx = linkedSubscription(s);
  s.api.transactions.set(tx.transactionId!, { ...tx, revocationDate: NOW.getTime() - 5000 });
  assertEquals(await outcome(await s.post(await signJws(notification('REVOKE', tx)))), 'processed');
  assert(s.sub(tx.originalTransactionId!)!.revoked_at);
  assertEquals(tierOf(s, OWNER), 'free');
});

Deno.test("first sight of a subscription links it by Apple's re-fetched token (only to an existing profile)", async () => {
  const s = setup();
  const tx = transaction({ appAccountToken: OWNER });
  s.api.add({ status: 1, tx });
  assertEquals(await outcome(await s.post(await signJws(notification('SUBSCRIBED', tx)))), 'processed');
  assertEquals(s.sub(tx.originalTransactionId!)!.user_id, OWNER);
  assertEquals(tierOf(s, OWNER), 'premium');

  const unknown = transaction({ appAccountToken: 'cccccccc-0000-4000-8000-000000000009' });
  s.api.add({ status: 1, tx: unknown });
  assertEquals(await outcome(await s.post(await signJws(notification('SUBSCRIBED', unknown)))), 'processed');
  assertEquals(s.sub(unknown.originalTransactionId!)!.user_id ?? null, null);
});

Deno.test('chain, shape and bundle checks', async () => {
  const s = setup();
  const tx = linkedSubscription(s);
  await assertApiError(await s.post(await signJws(notification('DID_RENEW', tx), { chain: 'rogue' })), 'unauthorized');
  await assertApiError(await s.post('nope'), 'invalid_payload');
  await assertApiError(await s.post(42), 'invalid_payload');
  await assertApiError(
    await s.post(await signJws({ notificationType: 'TEST', notificationUUID: 'not-a-uuid' })),
    'invalid_payload',
  );
  const foreign = notification('DID_RENEW', tx);
  foreign.data!.bundleId = 'com.other';
  assertEquals(await outcome(await s.post(await signJws(foreign))), 'ignored');
  assertEquals(s.inbox().length, 0);
  assertEquals(await outcome(await s.post(await signJws(notification('TEST', null)))), 'processed');
  assertEquals(s.api.calls.length, 0);
});

Deno.test('unknown subscription at Apple is a permanent failure: stored failed, acknowledged with 200', async () => {
  const s = setup();
  const tx = transaction();
  assertEquals(await outcome(await s.post(await signJws(notification('DID_RENEW', tx)))), 'failed');
  assertEquals(s.inbox()[0].status, 'failed');
});

Deno.test('CONSUMPTION_REQUEST: sent only with consumption_consent; usage share in milli-percent', async () => {
  const s = setup();
  const tx = linkedSubscription(s, {
    purchaseDate: Date.parse('2026-10-01T00:00:00+07:00'),
    expiresDate: Date.parse('2026-11-01T00:00:00+07:00'),
  });
  s.db.seed('public', 'plan_limits', [{ tier: 'premium', total_limit: 15 }, { tier: 'trial', total_limit: 10 }]);
  s.db.seed('public', 'usage_counters', [
    { user_id: OWNER, period_key: `sub:${tx.originalTransactionId}:2026-10-01`, used: 6 },
    { user_id: OWNER, period_key: '2026-09', used: 2 },
  ]);
  const jws1 = await signJws(notification('CONSUMPTION_REQUEST', tx));
  assertEquals(await outcome(await s.post(jws1)), 'processed');
  assertEquals(s.api.consumptionCalls.length, 0, 'no consent → log only');

  s.db.table('public', 'profiles').find((p) => p.id === OWNER)!.consumption_consent = true;
  assertEquals(await outcome(await s.post(await signJws(notification('CONSUMPTION_REQUEST', tx)))), 'processed');
  assertEquals(s.api.consumptionCalls.length, 1);
  const call = s.api.consumptionCalls[0];
  assertEquals(call.transactionId, tx.transactionId);
  assertEquals(call.body, {
    customerConsented: true,
    sampleContentProvided: true,
    deliveryStatus: 'DELIVERED',
    consumptionPercentage: 40000, // 6 of 15
  });
  assertEquals(s.audit('consumption_sent').length, 1);
});

Deno.test('consumptionPercentage: trial, multi-month periods, caps', () => {
  const otx = '100';
  const base = { originalTransactionId: otx, counters: [], limits: { trial: 10, premium: 15 } };
  assertEquals(
    consumptionPercentage({
      ...base,
      isTrial: true,
      purchaseDate: 0,
      expiresDate: 1,
      counters: [{ period_key: `trial:${otx}`, used: 5 }],
    }),
    50000,
  );
  const start = Date.parse('2026-01-01T00:00:00+07:00');
  const yearly = {
    ...base,
    isTrial: false,
    purchaseDate: start,
    expiresDate: start + 365 * DAY_MS,
    counters: [
      { period_key: `sub:${otx}:2026-01-01`, used: 15 },
      { period_key: `sub:${otx}:2026-02-01`, used: 3 },
      { period_key: `sub:other:2026-02-01`, used: 9 },
      { period_key: `sub:${otx}:2025-06-01`, used: 9 },
    ],
  };
  assertEquals(consumptionPercentage(yearly), Math.round((18 / 180) * 100_000));
  assertEquals(
    consumptionPercentage({
      ...base,
      isTrial: true,
      purchaseDate: 0,
      expiresDate: 1,
      counters: [{ period_key: `trial:${otx}`, used: 99 }],
    }),
    100_000,
  );
  assertEquals(consumptionPercentage({ ...base, isTrial: false, purchaseDate: undefined, expiresDate: undefined }), 0);
});

Deno.test('notification history: last 26 h on Production and Sandbox, paginated, idempotent with the webhook', async () => {
  const s = setup();
  const tx = linkedSubscription(s);
  const already = await signJws(notification('DID_RENEW', tx));
  assertEquals(await outcome(await s.post(already)), 'processed'); // delivered by the webhook earlier
  const missed = await signJws(notification('DID_CHANGE_RENEWAL_PREF', tx));
  s.api.history.set('Sandbox', [
    { notificationHistory: [{ signedPayload: already }], hasMore: true, paginationToken: '1' },
    { notificationHistory: [{ signedPayload: missed }], hasMore: false },
  ]);
  s.api.failHistory.add('Production');

  const results = await syncNotificationHistory({
    db: s.db,
    api: s.api,
    roots: TEST_ROOTS,
    bundleId: BUNDLE_ID,
    log: s.log,
    now: () => NOW,
  });
  assertEquals(results.map((r) => r.environment), ['Production', 'Sandbox']);
  assertEquals(results[0].error, 'apple_503');
  assertEquals({ ...results[1] }, { environment: 'Sandbox', fetched: 2, processed: 1, duplicates: 1, failed: 0 });
  const req = s.api.historyRequests.find((r) => r.env === 'Sandbox')!.request;
  assertEquals(req.endDate - req.startDate, 26 * 3_600_000);
  assertEquals(req.endDate, NOW.getTime());
  assertEquals(s.api.historyRequests.filter((r) => r.env === 'Sandbox').map((r) => r.token), [undefined, '1']);
  assertEquals(s.inbox().filter((r) => r.status === 'processed').length, 2);
});

Deno.test('adversarial: a forged REFUND (untrusted chain) changes nothing and calls nobody', async () => {
  const s = setup();
  const tx = linkedSubscription(s);
  s.api.add({ status: 5, tx: { ...tx, revocationDate: NOW.getTime() } }); // even if Apple would agree
  s.api.calls.length = 0;
  for (const chain of ['rogue', 'mixed', 'leaf_no_oid'] as const) {
    await assertApiError(await s.post(await signJws(notification('REFUND', tx), { chain })), 'unauthorized');
  }
  assertEquals(s.inbox().length, 0);
  assertEquals(s.api.calls.length, 0);
  assertEquals(s.sub(tx.originalTransactionId!)!.revoked_at, null);
});
