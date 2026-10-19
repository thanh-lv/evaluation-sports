/**
 * App Store Server API client (DESIGN §9.4 step 3, §9.5, §1.1 item 7).
 *
 * Hosts default to `api.storekit.apple.com` / `api.storekit-sandbox.apple.com` (env `APPLE_API_HOST_PROD` /
 * `APPLE_API_HOST_SANDBOX`). Every call carries a cached ES256 bearer token (jwt.ts) and a timeout. `fetch` is
 * injected so tests run against an in-memory fake Apple.
 *
 * Responses are trusted because they come over TLS from Apple (§9.4 step 3); their `signed*` fields are decoded with
 * `decodeJwsPayload`, not re-verified.
 *
 * Errors: `AppleApiError` with the HTTP status, Apple's numeric `errorCode` and `transient` (network, timeout, 429,
 * 5xx). `toHttpErrorFromApple` maps one onto the response a handler should send.
 */
import type { AppleEnv } from '../env.ts';
import { ConfigError, HttpError, httpError } from '../errors.ts';
import { type FetchLike, fetchWithTimeout } from '../http.ts';
import { appStoreApiToken, cachedToken, type TokenProvider } from './jwt.ts';
import type { ApiEnvironment, NotificationHistoryResponse, StatusResponse, TransactionInfoResponse } from './types.ts';

export const APPLE_API_TIMEOUT_MS = 10_000;

export class AppleApiError extends Error {
  readonly status: number;
  readonly errorCode: number | null;
  readonly transient: boolean;
  constructor(message: string, status: number, errorCode: number | null, transient: boolean, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AppleApiError';
    this.status = status;
    this.errorCode = errorCode;
    this.transient = transient;
  }
}

/** Send Consumption Information (v2, App Store Server API 1.19) request body. */
export interface ConsumptionRequest {
  customerConsented: boolean;
  sampleContentProvided: boolean;
  deliveryStatus:
    | 'DELIVERED'
    | 'UNDELIVERED_QUALITY_ISSUE'
    | 'UNDELIVERED_WRONG_ITEM'
    | 'UNDELIVERED_SERVER_OUTAGE'
    | 'UNDELIVERED_OTHER';
  /** Share of the purchase consumed, in thousandths of a percent (0–100000). */
  consumptionPercentage?: number;
  refundPreference?: 'DECLINE' | 'GRANT_FULL' | 'GRANT_PRORATED';
}

export interface NotificationHistoryRequest {
  /** ms since epoch. */
  startDate: number;
  endDate: number;
  notificationType?: string;
  transactionId?: string;
  onlyFailures?: boolean;
}

export interface AppStoreApi {
  getAllSubscriptionStatuses(env: ApiEnvironment, transactionId: string): Promise<StatusResponse>;
  getTransactionInfo(env: ApiEnvironment, transactionId: string): Promise<TransactionInfoResponse>;
  /** Set App Account Token: re-points `appAccountToken` of every transaction of the subscription. */
  setAppAccountToken(env: ApiEnvironment, originalTransactionId: string, appAccountToken: string): Promise<void>;
  sendConsumptionInformation(env: ApiEnvironment, transactionId: string, body: ConsumptionRequest): Promise<void>;
  getNotificationHistory(
    env: ApiEnvironment,
    request: NotificationHistoryRequest,
    paginationToken?: string,
  ): Promise<NotificationHistoryResponse>;
}

export interface AppStoreApiConfig {
  origins: { production: string; sandbox: string };
  token: TokenProvider;
  fetch?: FetchLike;
  timeoutMs?: number;
}

const ID_RE = /^[0-9A-Za-z._-]{1,64}$/;

function checkId(id: string, what: string): string {
  if (!ID_RE.test(id)) throw httpError('invalid_payload', `bad ${what}`);
  return encodeURIComponent(id);
}

export function createAppStoreApi(config: AppStoreApiConfig): AppStoreApi {
  const doFetch = fetchWithTimeout(config.timeoutMs ?? APPLE_API_TIMEOUT_MS, config.fetch ?? fetch);
  const origin = (env: ApiEnvironment) => (env === 'Production' ? config.origins.production : config.origins.sandbox);

  async function call(env: ApiEnvironment, method: string, path: string, body?: unknown): Promise<Response> {
    const token = await config.token();
    let res: Response;
    try {
      res = await doFetch(`${origin(env)}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new AppleApiError(`apple ${method} ${path.split('/').slice(0, 4).join('/')} failed`, 0, null, true, err);
    }
    if (res.ok) return res;
    let errorCode: number | null = null;
    try {
      const parsed = (await res.json()) as { errorCode?: unknown };
      if (typeof parsed?.errorCode === 'number') errorCode = parsed.errorCode;
    } catch {
      // no JSON body
    }
    const transient = res.status === 429 || res.status >= 500;
    throw new AppleApiError(
      `apple api ${res.status}${errorCode ? ` (${errorCode})` : ''}`,
      res.status,
      errorCode,
      transient,
    );
  }

  const jsonOf = async <T>(res: Response): Promise<T> => {
    try {
      return (await res.json()) as T;
    } catch (err) {
      throw new AppleApiError('apple api returned invalid JSON', res.status, null, true, err);
    }
  };
  const drain = async (res: Response) => {
    await res.body?.cancel().catch(() => {});
  };

  return {
    async getAllSubscriptionStatuses(env, transactionId) {
      const res = await call(env, 'GET', `/inApps/v1/subscriptions/${checkId(transactionId, 'transactionId')}`);
      const body = await jsonOf<StatusResponse>(res);
      if (!Array.isArray(body?.data)) throw new AppleApiError('apple status response has no data', 200, null, true);
      return body;
    },
    async getTransactionInfo(env, transactionId) {
      const res = await call(env, 'GET', `/inApps/v1/transactions/${checkId(transactionId, 'transactionId')}`);
      return await jsonOf<TransactionInfoResponse>(res);
    },
    async setAppAccountToken(env, originalTransactionId, appAccountToken) {
      const id = checkId(originalTransactionId, 'originalTransactionId');
      await drain(await call(env, 'PUT', `/inApps/v1/transactions/${id}/appAccountToken`, { appAccountToken }));
    },
    async sendConsumptionInformation(env, transactionId, body) {
      const id = checkId(transactionId, 'transactionId');
      await drain(await call(env, 'PUT', `/inApps/v2/transactions/consumption/${id}`, body));
    },
    async getNotificationHistory(env, request, paginationToken) {
      const query = paginationToken ? `?paginationToken=${encodeURIComponent(paginationToken)}` : '';
      const res = await call(env, 'POST', `/inApps/v1/notifications/history${query}`, request);
      return await jsonOf<NotificationHistoryResponse>(res);
    },
  };
}

/** The real client from env (`APPLE_IAP_*`, `APPLE_BUNDLE_ID`); missing keys fail on first use with a ConfigError. */
export function createAppStoreApiFromEnv(apple: AppleEnv, fetchImpl?: FetchLike): AppStoreApi {
  const sign = (now: Date) => {
    if (!apple.iapKeyId || !apple.iapIssuerId || !apple.iapPrivateKey || !apple.bundleId) {
      return Promise.reject(
        new ConfigError(
          'missing environment: APPLE_IAP_KEY_ID, APPLE_IAP_ISSUER_ID, APPLE_IAP_PRIVATE_KEY, APPLE_BUNDLE_ID',
        ),
      );
    }
    return appStoreApiToken({
      keyId: apple.iapKeyId,
      issuerId: apple.iapIssuerId,
      bundleId: apple.bundleId,
      privateKey: apple.iapPrivateKey,
    }, now);
  };
  return createAppStoreApi({ origins: apple.apiOrigin, token: cachedToken(sign, 15 * 60), fetch: fetchImpl });
}

/**
 * HTTP mapping for a failed Apple call: transient → 502 `upstream_unavailable`; 401/403 (bad key) → 500 (logged as a
 * configuration problem); 404 → `notFound` (default 422 `invalid_payload`); other 4xx → 422.
 */
export function toHttpErrorFromApple(
  err: unknown,
  notFound: HttpError = httpError('invalid_payload', 'unknown transaction'),
) {
  if (!(err instanceof AppleApiError)) return err;
  if (err.transient) return httpError('upstream_unavailable', 'App Store unavailable', { cause: err });
  if (err.status === 401 || err.status === 403) return new HttpError('internal', 'internal error', { cause: err });
  if (err.status === 404) return notFound;
  return httpError('invalid_payload', 'rejected by the App Store', { cause: err });
}
