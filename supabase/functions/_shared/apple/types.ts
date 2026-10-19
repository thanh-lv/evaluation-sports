/**
 * Decoded App Store payloads (App Store Server API / Server Notifications V2). Only the fields we read are typed;
 * Apple adds fields over time, so every field is optional and the decoders never reject unknown keys.
 * Dates are milliseconds since the epoch.
 */

/** `environment` values. `Xcode` (StoreKit testing in Xcode) is accepted only with ALLOW_XCODE_ENV=true. */
export type AppleEnvironment = 'Production' | 'Sandbox' | 'Xcode' | 'LocalTesting';
/** The environments the App Store Server API serves. */
export type ApiEnvironment = 'Production' | 'Sandbox';

/** Subscription status codes: 1 active, 2 expired, 3 billing retry, 4 grace period, 5 revoked. */
export type SubscriptionStatus = 1 | 2 | 3 | 4 | 5;

export interface JwsTransaction {
  transactionId?: string;
  originalTransactionId?: string;
  webOrderLineItemId?: string;
  bundleId?: string;
  productId?: string;
  subscriptionGroupIdentifier?: string;
  purchaseDate?: number;
  originalPurchaseDate?: number;
  expiresDate?: number;
  quantity?: number;
  type?: string;
  /** The uid the app passed at purchase (or that Set App Account Token stored). Lowercase it before comparing. */
  appAccountToken?: string;
  inAppOwnershipType?: string;
  signedDate?: number;
  revocationReason?: number;
  revocationDate?: number;
  isUpgraded?: boolean;
  /** 1 introductory, 2 promotional, 3 offer code, 4 win-back. */
  offerType?: number;
  offerIdentifier?: string;
  offerDiscountType?: string;
  environment?: AppleEnvironment;
  storefront?: string;
  transactionReason?: string;
  price?: number;
  currency?: string;
  appTransactionId?: string;
}

export interface JwsRenewalInfo {
  originalTransactionId?: string;
  autoRenewProductId?: string;
  productId?: string;
  /** 1 on, 0 off. */
  autoRenewStatus?: number;
  expirationIntent?: number;
  isInBillingRetryPeriod?: boolean;
  gracePeriodExpiresDate?: number;
  offerType?: number;
  signedDate?: number;
  environment?: AppleEnvironment;
  recentSubscriptionStartDate?: number;
  renewalDate?: number;
}

export interface LastTransactionItem {
  originalTransactionId: string;
  status: SubscriptionStatus;
  signedTransactionInfo: string;
  signedRenewalInfo?: string;
}

export interface SubscriptionGroupItem {
  subscriptionGroupIdentifier: string;
  lastTransactions: LastTransactionItem[];
}

/** `GET /inApps/v1/subscriptions/{transactionId}`. */
export interface StatusResponse {
  environment?: ApiEnvironment;
  bundleId?: string;
  appAppleId?: number;
  data: SubscriptionGroupItem[];
}

/** `GET /inApps/v1/transactions/{transactionId}`. */
export interface TransactionInfoResponse {
  signedTransactionInfo: string;
}

export interface NotificationData {
  appAppleId?: number;
  bundleId?: string;
  bundleVersion?: string;
  environment?: AppleEnvironment;
  signedTransactionInfo?: string;
  signedRenewalInfo?: string;
  status?: SubscriptionStatus;
  consumptionRequestReason?: string;
}

/** Decoded `signedPayload` of an App Store Server Notification V2. */
export interface NotificationPayload {
  notificationType: string;
  subtype?: string;
  notificationUUID: string;
  version?: string;
  signedDate?: number;
  data?: NotificationData;
  /** RENEWAL_EXTENSION summaries carry no transaction. */
  summary?: Record<string, unknown>;
}

export interface NotificationHistoryItem {
  signedPayload: string;
}

/** `POST /inApps/v1/notifications/history`. */
export interface NotificationHistoryResponse {
  notificationHistory: NotificationHistoryItem[];
  hasMore?: boolean;
  paginationToken?: string;
}
