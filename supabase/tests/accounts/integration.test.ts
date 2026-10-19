/**
 * account-merge and delete-account against the running local stack (real Postgres functions, Storage, Auth admin,
 * ES256 user tokens); Apple and SIWA are fakes. Skipped when the stack is not reachable (see local_stack.ts).
 * Uses one anonymous sign-in (the local limit is 30/h per IP).
 */
import { assert, assertEquals } from '@std/assert';
import { createClaimsVerifier } from '@shared/auth.ts';
import { auditSubject, encryptString, importAesKey } from '@shared/crypto.ts';
import { createServiceClients } from '@shared/db.ts';
import { BUCKET_DERIVED, BUCKET_INPUTS } from '@shared/storage.ts';
import type { SiwaClient } from '@shared/apple/siwa.ts';
import { captureLogger, jsonRequest, readJsonResponse, TEST_TOKEN_ENC_KEY } from '@shared/testing/index.ts';
import { createAnonymousUser, createTestUser, deleteTestUser, getLocalStack } from '@shared/testing/local_stack.ts';
import { createAccountMergeHandler } from '../../functions/account-merge/handler.ts';
import { createDeleteAccountHandler } from '../../functions/delete-account/handler.ts';
import { FakeAppStoreApi, transaction } from '../apple/_apple.ts';

const stack = await getLocalStack();

function clients() {
  const env = { supabaseUrl: stack!.url, serviceKey: stack!.serviceKey, anonKey: stack!.anonKey };
  return { ...createServiceClients(env), verifier: createClaimsVerifier(env) };
}

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

Deno.test({
  name:
    'local stack: account-merge moves rows, files and subscription links, deletes the anonymous user; re-run is a no-op',
  ignore: !stack,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const c = clients();
    const perm = await createTestUser(stack!);
    const anon = await createAnonymousUser(stack!);
    const otx = `it-merge-${crypto.randomUUID()}`;
    try {
      const aid = crypto.randomUUID();
      await c.storage.upload(BUCKET_INPUTS, `${anon.userId}/${aid}/frames/F1.jpg`, jpeg, { contentType: 'image/jpeg' });
      await c.storage.upload(BUCKET_INPUTS, `${anon.userId}/${aid}/frames/F2.jpg`, jpeg, { contentType: 'image/jpeg' });
      await c.storage.uploadJson(BUCKET_DERIVED, `${anon.userId}/${aid}/pose.raw.json`, { schema: 'pose.v1' });
      await c.db.insert('public', 'events', { user_id: anon.userId, name: 'it.merge', props: {}, source: 'server' });
      await c.db.insert('public', 'usage_counters', { user_id: anon.userId, period_key: '2026-10', used: 1 });
      const tx = transaction({ originalTransactionId: otx, transactionId: otx, appAccountToken: anon.userId });
      await c.db.insert('public', 'app_store_subscriptions', {
        original_transaction_id: otx,
        user_id: anon.userId,
        app_account_token: anon.userId,
        environment: 'Sandbox',
        product_id: tx.productId,
        status: 1,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        transaction_info: tx,
      });
      const api = new FakeAppStoreApi().add({ status: 1, tx });
      const handler = createAccountMergeHandler({ ...c, api, logger: captureLogger().log });
      const call = () =>
        handler(
          jsonRequest('', { anonAccessToken: anon.accessToken }, { fn: 'account-merge', token: perm.accessToken }),
        );

      const res = await call();
      assertEquals(res.status, 200, await res.clone().text());
      assertEquals(await readJsonResponse(res), { merged: true });

      assertEquals((await c.storage.listRecursive(BUCKET_INPUTS, anon.userId)).length, 0);
      assertEquals((await c.storage.listRecursive(BUCKET_INPUTS, perm.userId)).sort(), [
        `${perm.userId}/${aid}/frames/F1.jpg`,
        `${perm.userId}/${aid}/frames/F2.jpg`,
      ]);
      assertEquals(await c.storage.listRecursive(BUCKET_DERIVED, perm.userId), [`${perm.userId}/${aid}/pose.raw.json`]);
      const ev = await c.db.selectMany('public', 'events', 'user_id', { name: 'it.merge', user_id: perm.userId });
      assertEquals(ev.length, 1);
      const counter = await c.db.selectOne<{ used: number }>('public', 'usage_counters', 'used', {
        user_id: perm.userId,
        period_key: '2026-10',
      });
      assertEquals(counter?.used, 1);
      const sub = await c.db.selectOne<{ user_id: string; app_account_token: string }>(
        'public',
        'app_store_subscriptions',
        'user_id, app_account_token',
        { original_transaction_id: otx },
      );
      assertEquals(sub, { user_id: perm.userId, app_account_token: perm.userId });
      assertEquals(api.setTokenCalls.map((x) => x.token), [perm.userId]);
      const ent = await c.db.selectOne<{ tier: string }>('public', 'entitlements', 'tier', { user_id: perm.userId });
      assertEquals(ent?.tier, 'premium');
      assertEquals(await c.authAdmin.getUser(anon.userId), null);
      const audit = await c.db.selectMany<{ action: string }>('private', 'audit_log', 'action', {
        subject: perm.userId,
      });
      assert(audit.some((a) => a.action === 'account_merge'));
      assert(audit.some((a) => a.action === 'account_merge_completed'));

      // re-run with the same (still unexpired) anonymous token: answered from the audit, nothing else happens
      const again = await call();
      assertEquals(await readJsonResponse(again), { merged: true });
      assertEquals(api.setTokenCalls.length, 1);
    } finally {
      await c.db.delete('public', 'app_store_subscriptions', { original_transaction_id: otx });
      for (const bucket of [BUCKET_INPUTS, BUCKET_DERIVED]) {
        await c.storage.removePrefix(bucket, perm.userId);
        await c.storage.removePrefix(bucket, anon.userId);
      }
      await deleteTestUser(stack!, perm.userId);
      await deleteTestUser(stack!, anon.userId);
    }
  },
});

Deno.test({
  name: 'local stack: delete-account removes files, token, links and the auth user; a re-run answers the same',
  ignore: !stack,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const c = clients();
    const user = await createTestUser(stack!);
    const otx = `it-delete-${crypto.randomUUID()}`;
    const revoked: string[] = [];
    const siwa: SiwaClient = {
      exchangeCode: () => Promise.reject(new Error('unused')),
      revoke: (t) => {
        revoked.push(t);
        return Promise.resolve();
      },
    };
    try {
      for (let i = 1; i <= 3; i++) {
        await c.storage.upload(BUCKET_INPUTS, `${user.userId}/a${i}/frames/F1.jpg`, jpeg, {
          contentType: 'image/jpeg',
        });
      }
      await c.storage.uploadJson(BUCKET_DERIVED, `${user.userId}/a1/pose.clean.json`, {});
      const key = await importAesKey(TEST_TOKEN_ENC_KEY);
      await c.db.insert('private', 'apple_auth_tokens', {
        user_id: user.userId,
        ciphertext: await encryptString(key, 'it-refresh', user.userId),
      });
      await c.db.insert('public', 'app_store_subscriptions', {
        original_transaction_id: otx,
        user_id: user.userId,
        app_account_token: user.userId,
        environment: 'Production',
        product_id: 'app.racketcoach.premium.yearly',
        status: 1,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      });
      const pepper = `it-${crypto.randomUUID()}`;
      const handler = createDeleteAccountHandler({
        ...c,
        siwa,
        tokenEncKey: TEST_TOKEN_ENC_KEY,
        auditPepper: pepper,
        logger: captureLogger().log,
      });
      const call = () => handler(jsonRequest('', { confirm: true }, { fn: 'delete-account', token: user.accessToken }));

      const res = await call();
      assertEquals(res.status, 200, await res.clone().text());
      const expected = { deleted: true, hadActiveSubscription: true, siwaManualRevoke: false };
      assertEquals(await readJsonResponse(res), expected);
      assertEquals(revoked, ['it-refresh']);
      assertEquals(await c.authAdmin.getUser(user.userId), null);
      assertEquals((await c.storage.listRecursive(BUCKET_INPUTS, user.userId)).length, 0);
      assertEquals((await c.storage.listRecursive(BUCKET_DERIVED, user.userId)).length, 0);
      assertEquals(await c.db.selectOne('private', 'apple_auth_tokens', 'user_id', { user_id: user.userId }), null);
      const sub = await c.db.selectOne('public', 'app_store_subscriptions', 'user_id, app_account_token', {
        original_transaction_id: otx,
      });
      assertEquals(sub, { user_id: null, app_account_token: null });
      assertEquals(await c.db.selectOne('public', 'profiles', 'id', { id: user.userId }), null);
      const subject = await auditSubject(user.userId, pepper);
      const audit = await c.db.selectMany<{ action: string }>('private', 'audit_log', 'action', { subject });
      assertEquals(audit.map((a) => a.action).sort(), ['account_delete_started', 'account_deleted', 'siwa_revoked']);

      // the access token stays valid until it expires (ES256, verified locally): a retry is answered the same
      const again = await call();
      assertEquals(again.status, 200, await again.clone().text());
      assertEquals(await readJsonResponse(again), expected);
      assertEquals(revoked.length, 1);
    } finally {
      await c.db.delete('public', 'app_store_subscriptions', { original_transaction_id: otx });
      for (const bucket of [BUCKET_INPUTS, BUCKET_DERIVED]) await c.storage.removePrefix(bucket, user.userId);
      await deleteTestUser(stack!, user.userId);
    }
  },
});
