/**
 * Test helpers for the Apple modules: the committed test chain (scripts/gen-test-certs.sh), JWS signing with the
 * leaf key, unsigned JWS for Apple API responses (trusted via TLS, never verified), payload builders and an
 * in-memory App Store Server API.
 */
import type { AppStoreApi, ConsumptionRequest, NotificationHistoryRequest } from '@shared/apple/api.ts';
import { AppleApiError } from '@shared/apple/api.ts';
import type {
  ApiEnvironment,
  JwsRenewalInfo,
  JwsTransaction,
  NotificationHistoryResponse,
  NotificationPayload,
  StatusResponse,
  SubscriptionStatus,
  TransactionInfoResponse,
} from '@shared/apple/types.ts';
import { pemCertificates } from '@shared/apple/der.ts';
import { toBase64Url } from '@shared/crypto.ts';

const APPLE_FIXTURES = new URL('../../../shared/fixtures/apple/', import.meta.url);

export const BUNDLE_ID = 'app.racketcoach.test';
/** A fixed "now" inside every test certificate's validity (2025-01-01 – 2050-01-01). */
export const NOW = new Date('2026-10-19T03:00:00Z');
export const DAY_MS = 86_400_000;

export function fixtureText(name: string): string {
  return Deno.readTextFileSync(new URL(name, APPLE_FIXTURES));
}

/** DER of the first certificate in a fixture PEM. */
export function certDer(name: string): Uint8Array<ArrayBuffer> {
  return pemCertificates(fixtureText(name))[0];
}

function derBase64(name: string): string {
  return btoa(String.fromCharCode(...certDer(name)));
}

/** The test root (stand-in for Apple Root CA G3) as the only trusted root. */
export const TEST_ROOTS: readonly Uint8Array[] = [certDer('root.crt.pem')];

export type ChainName = 'good' | 'rogue' | 'leaf_no_oid' | 'intermediate_no_oid' | 'leaf_expired' | 'mixed';

const CHAINS: Record<ChainName, { certs: [string, string, string]; key: string }> = {
  good: { certs: ['leaf.crt.pem', 'intermediate.crt.pem', 'root.crt.pem'], key: 'leaf.key.pem' },
  rogue: {
    certs: ['rogue_leaf.crt.pem', 'rogue_intermediate.crt.pem', 'rogue_root.crt.pem'],
    key: 'rogue_leaf.key.pem',
  },
  leaf_no_oid: { certs: ['leaf_no_oid.crt.pem', 'intermediate.crt.pem', 'root.crt.pem'], key: 'leaf.key.pem' },
  intermediate_no_oid: {
    certs: ['leaf.crt.pem', 'intermediate_no_oid.crt.pem', 'root.crt.pem'],
    key: 'leaf.key.pem',
  },
  leaf_expired: { certs: ['leaf_expired.crt.pem', 'intermediate.crt.pem', 'root.crt.pem'], key: 'leaf.key.pem' },
  // a rogue leaf and intermediate presented with the trusted root
  mixed: { certs: ['rogue_leaf.crt.pem', 'rogue_intermediate.crt.pem', 'root.crt.pem'], key: 'rogue_leaf.key.pem' },
};

const keyCache = new Map<string, Promise<CryptoKey>>();

function importLeafKey(name: string): Promise<CryptoKey> {
  let k = keyCache.get(name);
  if (!k) {
    const b64 = fixtureText(name).replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
    const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    k = crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    keyCache.set(name, k);
  }
  return k;
}

const b64url = (o: unknown) => toBase64Url(new TextEncoder().encode(JSON.stringify(o)));

export interface SignOptions {
  chain?: ChainName;
  /** Sign with this chain's key instead (key/certificate mismatch cases). */
  keyFrom?: ChainName;
  header?: Record<string, unknown>;
}

/** A compact JWS signed ES256 by the chain's leaf key, with `x5c` = [leaf, intermediate, root]. */
export async function signJws(payload: unknown, options: SignOptions = {}): Promise<string> {
  const chain = CHAINS[options.chain ?? 'good'];
  const header = { alg: 'ES256', x5c: chain.certs.map(derBase64), ...(options.header ?? {}) };
  const input = `${b64url(header)}.${b64url(payload)}`;
  const key = await importLeafKey(CHAINS[options.keyFrom ?? options.chain ?? 'good'].key);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(input));
  return `${input}.${toBase64Url(new Uint8Array(sig))}`;
}

/** A JWS-shaped string with no real signature (what the fake Apple API returns; decoded without trust). */
export function unsignedJws(payload: unknown): string {
  return `${b64url({ alg: 'ES256', x5c: [] })}.${b64url(payload)}.c2ln`;
}

// ---------------------------------------------------------------------------------------------------------------
// Payload builders

let txCounter = 1000;
export function nextTxId(): string {
  return String(2000000000000000 + txCounter++);
}

export function transaction(overrides: Partial<JwsTransaction> = {}): JwsTransaction {
  const id = overrides.transactionId ?? nextTxId();
  return {
    transactionId: id,
    originalTransactionId: overrides.originalTransactionId ?? id,
    bundleId: BUNDLE_ID,
    productId: 'app.racketcoach.premium.monthly',
    subscriptionGroupIdentifier: '21000000',
    purchaseDate: NOW.getTime() - 2 * DAY_MS,
    originalPurchaseDate: NOW.getTime() - 2 * DAY_MS,
    expiresDate: NOW.getTime() + 28 * DAY_MS,
    type: 'Auto-Renewable Subscription',
    inAppOwnershipType: 'PURCHASED',
    signedDate: NOW.getTime() - 60_000,
    environment: 'Sandbox',
    ...overrides,
  };
}

export function notification(
  type: string,
  tx: JwsTransaction | null,
  overrides: Partial<NotificationPayload> = {},
): NotificationPayload {
  return {
    notificationType: type,
    notificationUUID: crypto.randomUUID(),
    version: '2.0',
    signedDate: NOW.getTime() - 1000,
    data: {
      appAppleId: 1234567890,
      bundleId: BUNDLE_ID,
      environment: tx?.environment === 'Production' ? 'Production' : 'Sandbox',
      ...(tx ? { signedTransactionInfo: unsignedJws(tx) } : {}),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// In-memory App Store Server API

export interface FakeSubscription {
  status: SubscriptionStatus;
  /** Latest transaction (what the status endpoint returns). */
  tx: JwsTransaction;
  renewal?: JwsRenewalInfo;
}

export class FakeAppStoreApi implements AppStoreApi {
  /** Keyed by originalTransactionId. */
  readonly subs = new Map<string, FakeSubscription>();
  /** Individual transactions (getTransactionInfo), keyed by transactionId. */
  readonly transactions = new Map<string, JwsTransaction>();
  readonly calls: { op: string; env: ApiEnvironment; id?: string }[] = [];
  readonly setTokenCalls: { env: ApiEnvironment; originalTransactionId: string; token: string }[] = [];
  readonly consumptionCalls: { env: ApiEnvironment; transactionId: string; body: ConsumptionRequest }[] = [];
  /** Pages of notification history per environment. */
  readonly history = new Map<ApiEnvironment, NotificationHistoryResponse[]>();
  readonly historyRequests: { env: ApiEnvironment; request: NotificationHistoryRequest; token?: string }[] = [];
  /** Next call of any kind throws this (once). */
  failNext: Error | null = null;
  /** Every Set App Account Token call throws this. */
  failSetToken: Error | null = null;
  /** Environments whose history listing throws. */
  failHistory = new Set<ApiEnvironment>();

  add(sub: FakeSubscription): this {
    this.subs.set(sub.tx.originalTransactionId!, structuredClone(sub));
    this.transactions.set(sub.tx.transactionId!, structuredClone(sub.tx));
    return this;
  }

  private check(op: string, env: ApiEnvironment, id?: string): void {
    this.calls.push({ op, env, id });
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
  }

  private find(transactionId: string): FakeSubscription | undefined {
    for (const s of this.subs.values()) {
      if (s.tx.transactionId === transactionId || s.tx.originalTransactionId === transactionId) return s;
    }
    const tx = this.transactions.get(transactionId);
    return tx?.originalTransactionId ? this.subs.get(tx.originalTransactionId) : undefined;
  }

  getAllSubscriptionStatuses(env: ApiEnvironment, transactionId: string): Promise<StatusResponse> {
    return Promise.resolve().then(() => {
      this.check('status', env, transactionId);
      const sub = this.find(transactionId);
      if (!sub) throw new AppleApiError('apple api 404 (4040010)', 404, 4040010, false);
      return {
        environment: env,
        bundleId: sub.tx.bundleId,
        appAppleId: 1234567890,
        data: [{
          subscriptionGroupIdentifier: sub.tx.subscriptionGroupIdentifier ?? 'g',
          lastTransactions: [{
            originalTransactionId: sub.tx.originalTransactionId!,
            status: sub.status,
            signedTransactionInfo: unsignedJws(sub.tx),
            signedRenewalInfo: unsignedJws(
              sub.renewal ?? { originalTransactionId: sub.tx.originalTransactionId, autoRenewStatus: 1 },
            ),
          }],
        }],
      };
    });
  }

  getTransactionInfo(env: ApiEnvironment, transactionId: string): Promise<TransactionInfoResponse> {
    return Promise.resolve().then(() => {
      this.check('transaction', env, transactionId);
      const tx = this.transactions.get(transactionId) ?? this.find(transactionId)?.tx;
      if (!tx) throw new AppleApiError('apple api 404 (4040010)', 404, 4040010, false);
      return { signedTransactionInfo: unsignedJws(tx) };
    });
  }

  setAppAccountToken(env: ApiEnvironment, originalTransactionId: string, appAccountToken: string): Promise<void> {
    return Promise.resolve().then(() => {
      this.check('setToken', env, originalTransactionId);
      if (this.failSetToken) throw this.failSetToken;
      this.setTokenCalls.push({ env, originalTransactionId, token: appAccountToken });
      const sub = this.subs.get(originalTransactionId);
      if (!sub) throw new AppleApiError('apple api 404 (4040010)', 404, 4040010, false);
      sub.tx.appAccountToken = appAccountToken;
    });
  }

  sendConsumptionInformation(env: ApiEnvironment, transactionId: string, body: ConsumptionRequest): Promise<void> {
    return Promise.resolve().then(() => {
      this.check('consumption', env, transactionId);
      this.consumptionCalls.push({ env, transactionId, body: structuredClone(body) });
    });
  }

  getNotificationHistory(
    env: ApiEnvironment,
    request: NotificationHistoryRequest,
    paginationToken?: string,
  ): Promise<NotificationHistoryResponse> {
    return Promise.resolve().then(() => {
      this.check('history', env);
      this.historyRequests.push({ env, request, token: paginationToken });
      if (this.failHistory.has(env)) throw new AppleApiError('apple api 503', 503, null, true);
      const pages = this.history.get(env) ?? [];
      const index = paginationToken ? Number(paginationToken) : 0;
      return pages[index] ?? { notificationHistory: [], hasMore: false };
    });
  }

  callsOf(op: string): number {
    return this.calls.filter((c) => c.op === op).length;
  }
}
