/**
 * Small HTTP bodies shared by the edge functions and the iOS app (DESIGN.md §6.1, §9.4; DESIGN-v1.0 §6.1).
 * The big documents (pose.v1, prepare.v1, coach-result.v1) live in their own files.
 * Errors on every route use `ApiError` from common.ts.
 */
import { z } from 'zod';
import { AnalysisStatus, LocalizedText, LowerUuid, SkillId, Sport, Tier, VIEW_CODES } from './common.ts';

const ViewCodeSchema = z.enum(VIEW_CODES);

// ---------------------------------------------------------------------------------------------------------------
// GET /analyze/catalog

export const CatalogSkill = z.object({
  id: SkillId,
  sport: Sport,
  name: LocalizedText,
  views: z.object({ recommended: z.array(ViewCodeSchema), allowed: z.array(ViewCodeSchema) }),
  /** Share (0..1) of the skill's checkpoint weight that is assessable from each allowed view. */
  viewCoverage: z.partialRecord(ViewCodeSchema, z.number().min(0).max(1)),
  /** Practisable alone (serves): picker badge. */
  solo: z.boolean(),
}).meta({ id: 'CatalogSkill' });
export type CatalogSkill = z.infer<typeof CatalogSkill>;

/** Paywall copy numbers, straight from `plan_limits` (DESIGN.md §2.2 step 11, §9.3). */
export const CatalogPlan = z.object({
  tier: Tier,
  periodType: z.enum(['calendar_month', 'trial', 'subscription_month']),
  totalLimit: z.number().int().nonnegative(),
  standardLimit: z.number().int().nonnegative(),
}).meta({ id: 'CatalogPlan' });
export type CatalogPlan = z.infer<typeof CatalogPlan>;

export const CatalogResponseV1 = z.object({
  schema: z.literal('catalog.v1'),
  /** Enabled skills only (rubric ∩ `enabled_skills`). */
  skills: z.array(CatalogSkill),
  plans: z.array(CatalogPlan),
});
export type CatalogResponseV1 = z.infer<typeof CatalogResponseV1>;

// ---------------------------------------------------------------------------------------------------------------
// POST /analyze/submit

export const SubmitRequest = z.object({
  analysisId: LowerUuid,
  /** DeviceCheck token, sent with the first-ever submit only (free first-analysis bonus). */
  deviceCheckToken: z.string().nullish(),
});
export type SubmitRequest = z.infer<typeof SubmitRequest>;

/** 202 when queued/processing (idempotent), 200 when already succeeded. */
export const SubmitResponse = z.object({
  status: AnalysisStatus.extract(['queued', 'processing', 'succeeded']),
  pollAfterMs: z.number().int().nonnegative(),
});
export type SubmitResponse = z.infer<typeof SubmitResponse>;

// ---------------------------------------------------------------------------------------------------------------
// POST /verify-subscription

export const VERIFY_REASONS = ['purchase', 'restore', 'launch', 'update'] as const;

export const VerifySubscriptionRequest = z.object({
  /** StoreKit 2 `Transaction.jwsRepresentation`; decoded without trust, then re-fetched from Apple. */
  signedTransaction: z.string(),
  /** Only `restore` may move a subscription linked to another live account (DESIGN.md §9.4 step 4). */
  reason: z.enum(VERIFY_REASONS),
});
export type VerifySubscriptionRequest = z.infer<typeof VerifySubscriptionRequest>;

export const VerifySubscriptionResponse = z.object({
  tier: Tier,
  productId: z.string().nullable(),
  /** ISO 8601; already coalesced with the grace period. */
  expiresAt: z.string().nullable(),
  willRenew: z.boolean(),
  inGrace: z.boolean(),
  billingIssue: z.boolean(),
  isTrial: z.boolean(),
  /** True when a restore moved the subscription to this account. */
  transferred: z.boolean(),
});
export type VerifySubscriptionResponse = z.infer<typeof VerifySubscriptionResponse>;

// ---------------------------------------------------------------------------------------------------------------
// Accounts

export const AppleAuthExchangeRequest = z.object({ authorizationCode: z.string().min(1) });
export type AppleAuthExchangeRequest = z.infer<typeof AppleAuthExchangeRequest>;

/** Sent with the permanent account's JWT; the anonymous session's access token proves ownership. */
export const AccountMergeRequest = z.object({ anonAccessToken: z.string().min(1) });
export type AccountMergeRequest = z.infer<typeof AccountMergeRequest>;
export const AccountMergeResponse = z.object({ merged: z.boolean() });
export type AccountMergeResponse = z.infer<typeof AccountMergeResponse>;

export const DeleteAccountRequest = z.object({ confirm: z.literal(true) });
export type DeleteAccountRequest = z.infer<typeof DeleteAccountRequest>;
export const DeleteAccountResponse = z.object({
  deleted: z.boolean(),
  hadActiveSubscription: z.boolean(),
  /** No SIWA refresh token was stored: the app tells the user to revoke in Settings › Apple ID. */
  siwaManualRevoke: z.boolean(),
});
export type DeleteAccountResponse = z.infer<typeof DeleteAccountResponse>;
