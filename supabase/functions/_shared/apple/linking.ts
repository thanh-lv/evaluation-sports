/**
 * The §9.4 linking policy as a pure function. The token always comes from Apple's re-fetched transaction; the handler
 * resolves who owns it (`resolveTokenOwner`) and what our row says (`rowOwner`), then acts on the decision.
 *
 * | Apple token                                                      | Decision                                  |
 * |------------------------------------------------------------------|-------------------------------------------|
 * | equals the caller                                                | link                                      |
 * | null, a deleted user, or an anonymous user merged into the caller | verify the client JWS chain, link, Set App Account Token |
 * | a different live user, reason = restore                          | transfer (rate-limited) + Set App Account Token |
 * | a different live user, other reasons                             | 409 `linked_to_other_account`             |
 *
 * Hardening rules on top of the table (reported as deviations):
 * - our row already linked to the caller wins over a stale Apple token (e.g. Set App Account Token failed after a
 *   transfer): link and re-point the token, so a later `launch` sync cannot undo the transfer;
 * - a null/deleted/merged token while our row is held by another live user is treated like "a different live user"
 *   (a stale Apple token must not silently move someone else's subscription);
 * - a transfer also requires a valid client JWS chain (the caller must hold Apple-signed proof of the purchase).
 */
import type { VerifySubscriptionRequest } from '@shared/contracts/index.ts';

export type VerifyReason = VerifySubscriptionRequest['reason'];

export type TokenOwner = 'caller' | 'none' | 'deleted' | 'merged_into_caller' | 'other_live';
export type RowOwner = 'none' | 'caller' | 'other_live';

export interface LinkInput {
  reason: VerifyReason;
  tokenOwner: TokenOwner;
  /** `app_store_subscriptions.user_id` today (`none` when no row, null, or a deleted user). */
  rowOwner: RowOwner;
}

export type LinkDecision =
  | { action: 'link'; verifyChain: boolean; setToken: boolean }
  | { action: 'transfer'; verifyChain: true; setToken: true }
  | { action: 'reject'; code: 'linked_to_other_account' };

export function decideLink(input: LinkInput): LinkDecision {
  if (input.tokenOwner === 'caller') return { action: 'link', verifyChain: false, setToken: false };
  if (input.rowOwner === 'caller') return { action: 'link', verifyChain: false, setToken: true };
  const heldByOther = input.tokenOwner === 'other_live' || input.rowOwner === 'other_live';
  if (!heldByOther) return { action: 'link', verifyChain: true, setToken: true };
  return input.reason === 'restore'
    ? { action: 'transfer', verifyChain: true, setToken: true }
    : { action: 'reject', code: 'linked_to_other_account' };
}

/** What the handler needs to classify a token (I/O injected). */
export interface OwnerLookup {
  /** null when the user does not exist. */
  getUser(userId: string): Promise<{ id: string; isAnonymous: boolean } | null>;
  /** True when anonymous user `fromId` was merged into `intoId` (audit `account_merge`). */
  wasMergedInto(fromId: string, intoId: string): Promise<boolean>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Lowercase canonical uuid, or null for a missing / non-uuid token. */
export function normalizeToken(token: unknown): string | null {
  if (typeof token !== 'string') return null;
  const t = token.trim().toLowerCase();
  return UUID_RE.test(t) ? t : null;
}

export async function resolveTokenOwner(
  token: string | null,
  callerId: string,
  lookup: OwnerLookup,
): Promise<TokenOwner> {
  if (token === null) return 'none';
  if (token === callerId) return 'caller';
  if (await lookup.wasMergedInto(token, callerId)) return 'merged_into_caller';
  const user = await lookup.getUser(token);
  return user === null ? 'deleted' : 'other_live';
}

export async function resolveRowOwner(
  rowUserId: string | null | undefined,
  callerId: string,
  lookup: OwnerLookup,
): Promise<RowOwner> {
  if (!rowUserId) return 'none';
  const id = rowUserId.toLowerCase();
  if (id === callerId) return 'caller';
  return (await lookup.getUser(id)) === null ? 'none' : 'other_live';
}
