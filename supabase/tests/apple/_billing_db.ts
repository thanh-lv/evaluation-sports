/**
 * A FakeDb with JS stand-ins for the billing/account SQL functions (supabase/migrations/…0400_functions.sql), close
 * enough for handler unit tests: `recompute_entitlement`, `transfer_subscription` (3 per 30 days) and
 * `merge_anonymous_account`. The real functions are covered by pgTAP (070_entitlements, 110_merge_consent).
 */
import type { Row } from '@shared/db.ts';
import { FakeAuthAdmin, FakeDb } from '@shared/testing/index.ts';
import { DAY_MS, NOW } from './_apple.ts';

export interface BillingDb {
  db: FakeDb;
  authAdmin: FakeAuthAdmin;
  /** Adds an auth user and its profile. */
  addUser(id: string, options?: { anonymous?: boolean; consumptionConsent?: boolean }): void;
  /** Removes an auth user and its profile (subscriptions keep the row with user_id null, like ON DELETE SET NULL). */
  removeUser(id: string): void;
  subs(): Row[];
  sub(originalTransactionId: string): Row | undefined;
  audit(action?: string): Row[];
}

const ts = (v: unknown): number => (typeof v === 'string' ? Date.parse(v) : NaN);

export function billingDb(now: () => Date = () => NOW): BillingDb {
  const db = new FakeDb();
  const authAdmin = new FakeAuthAdmin();
  const subs = () => db.table('public', 'app_store_subscriptions');
  const profiles = () => db.table('public', 'profiles');

  const recompute = (userId: string) => {
    if (!profiles().some((p) => p.id === userId)) return null;
    const t = now().getTime();
    const effective = (s: Row) => Math.max(ts(s.grace_expires_at) || 0, ts(s.expires_at) || 0);
    const live = subs()
      .filter((s) => s.user_id === userId && !s.revoked_at && [1, 4].includes(Number(s.status)) && effective(s) > t)
      .sort((a, b) => effective(b) - effective(a))[0];
    const e = live
      ? {
        tier: live.is_trial ? 'trial' : 'premium',
        productId: live.product_id as string,
        expiresAt: new Date(effective(live)).toISOString(),
        willRenew: live.auto_renew === true,
        inGrace: Number(live.status) === 4,
        billingIssue: [3, 4].includes(Number(live.status)),
        isTrial: live.is_trial === true,
      }
      : {
        tier: 'free',
        productId: null,
        expiresAt: null,
        willRenew: false,
        inGrace: false,
        billingIssue: false,
        isTrial: false,
      };
    const ents = db.table('public', 'entitlements');
    const i = ents.findIndex((r) => r.user_id === userId);
    if (i >= 0) ents.splice(i, 1);
    ents.push({ user_id: userId, ...e });
    return e;
  };

  db.onRpc('private', 'recompute_entitlement', (a) => recompute(String(a.p_user_id)));

  db.onRpc('private', 'transfer_subscription', (a) => {
    const otx = String(a.p_original_transaction_id);
    const to = String(a.p_to_user_id);
    const s = subs().find((r) => r.original_transaction_id === otx);
    if (!s) return { ok: false, code: 'not_found' };
    if (s.user_id === to) return { ok: true, transferred: false };
    const transfers = db.table('private', 'link_transfers');
    const count = transfers.filter((r) =>
      r.original_transaction_id === otx && ts(r.created_at) > now().getTime() - 30 * DAY_MS
    ).length;
    if (count >= 3) return { ok: false, code: 'transfer_rate_limited', count30d: count };
    const from = (s.user_id as string | null) ?? null;
    transfers.push({
      original_transaction_id: otx,
      from_user_id: from,
      to_user_id: to,
      created_at: now().toISOString(),
    });
    s.user_id = to;
    s.app_account_token = to;
    db.table('private', 'audit_log').push({ action: 'subscription_transfer', subject: otx, details: { from, to } });
    if (from) recompute(from);
    recompute(to);
    return { ok: true, transferred: true, fromUserId: from, count30d: count + 1 };
  });

  db.onRpc('private', 'merge_anonymous_account', (a) => {
    const from = String(a.p_from_user_id);
    const to = String(a.p_to_user_id);
    const src = authAdmin.users.get(from);
    if (!src) return { merged: false, code: 'not_found' };
    if (!src.isAnonymous || authAdmin.users.get(to)?.isAnonymous !== false) return { merged: false, code: 'forbidden' };
    let analyses = 0;
    for (const r of db.table('public', 'analyses')) {
      if (r.user_id === from) {
        r.user_id = to;
        analyses++;
      }
    }
    for (const r of db.table('public', 'events')) if (r.user_id === from) r.user_id = to;
    const moved: string[] = [];
    for (const s of subs()) {
      if (s.user_id === from) {
        s.user_id = to;
        s.app_account_token = to;
        moved.push(String(s.original_transaction_id));
      }
    }
    recompute(to);
    db.table('private', 'audit_log').push({
      action: 'account_merge',
      subject: to,
      details: { from, analyses, subscriptions: moved },
    });
    return { merged: true, analyses, events: 0, counters: 0, subscriptions: moved.sort() };
  });

  return {
    db,
    authAdmin,
    addUser(id, options = {}) {
      authAdmin.addUser({ id, isAnonymous: options.anonymous ?? false });
      profiles().push({ id, consumption_consent: options.consumptionConsent ?? false });
    },
    removeUser(id) {
      authAdmin.users.delete(id);
      const p = profiles();
      const i = p.findIndex((r) => r.id === id);
      if (i >= 0) p.splice(i, 1);
      for (const s of subs()) if (s.user_id === id) s.user_id = null;
    },
    subs,
    sub: (otx) => subs().find((r) => r.original_transaction_id === otx),
    audit: (action) => db.table('private', 'audit_log').filter((r) => action === undefined || r.action === action),
  };
}
