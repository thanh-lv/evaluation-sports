# Subscriptions: App Store Connect setup

Source: DESIGN.md §9.1–9.3, §9.6 and D17. Unit economics: `docs/economics.md`. Set this up at M15 and keep `ios/RacketCoach/Resources/Products.storekit` in sync (DESIGN.md §9.6); `scripts/check_ios_resources.py` asserts that its product IDs equal the `StoreService` constants.

## 1. Subscription group

| Field | Value |
|---|---|
| Reference name | `Premium` |
| Group ID | Copy into `SUBSCRIPTION_GROUP_ID` in the xcconfig (hosts and IDs only, never URLs) |
| Display name (vi) | RacketCoach Premium |
| Display name (en) | RacketCoach Premium |

## 2. Products

Replace `<company>` with the company reverse-DNS chosen on day 1 (DESIGN.md §15); it must match the bundle ID `com.<company>.racketcoach`.

| Field | Monthly | Yearly |
|---|---|---|
| Reference name | Premium Monthly | Premium Yearly |
| Product ID | `com.<company>.racketcoach.premium.monthly` | `com.<company>.racketcoach.premium.yearly` |
| Duration | 1 month | 1 year |
| Subscription level | 1 | 1 (same level as monthly, so switching is a crossgrade) |
| Price, Vietnam (set manually) | **79,000₫** | **599,000₫** |
| Introductory offer | None | **Free trial, 1 week**, new subscribers only |
| Family Sharing | Off | Off |
| Availability (Phase 1) | Vietnam only | Vietnam only |
| Review screenshot | Paywall screenshot | Paywall screenshot |

**Verify the price points.** App Store Connect only offers fixed price points per currency. Before launch, open the price picker for the Vietnam storefront and confirm that 79,000₫ and 599,000₫ exist. If one does not, pick the nearest point (prefer the lower one), then update: this file, `docs/legal/terms-of-use.*.md` §8, `docs/economics.md` and the `standard_limit` check. Set Vietnam manually; never let Apple derive the VND price from a USD base (it would land near 260,000₫).

**Phase 2 (not now):** base $9.99 / $59.99 with manual lower prices for Indonesia, Malaysia, Thailand, Philippines and India (DESIGN.md §9.2).

## 3. Localized display names and descriptions

Display name ≤ 30 characters, description ≤ 45 characters. Descriptions carry no quota numbers on purpose: the premium quota can drop below 15 under the `standard_limit` rule (DESIGN.md §9.3), and the exact numbers are always shown in the paywall from `plan_limits`. Changing these strings needs App Review.

| Product | Language | Display name | Description |
|---|---|---|---|
| Monthly | vi | Premium theo tháng | Phân tích nâng cao và báo cáo đầy đủ |
| Monthly | en | Premium Monthly | Advanced analyses and full reports |
| Yearly | vi | Premium theo năm | Báo cáo đầy đủ, trả theo năm |
| Yearly | en | Premium Yearly | Full reports, billed yearly |

## 4. Group and app settings

| Setting | Value | Why |
|---|---|---|
| Billing Grace Period | On, 16 days, all renewals | Premium continues while Apple retries payment; the server stores `expires_at` with grace included |
| Family Sharing | Off | Cannot be turned off once enabled |
| App Store Server Notifications V2 | Production and Sandbox URLs both `https://{{SUPABASE_HOST}}/functions/v1/appstore-webhook` | DESIGN.md §9.5 |
| In-App Purchase key | Generate in Users and Access › Integrations; store as the `APPLE_*` secrets for `verify-subscription` | DESIGN.md §9.4 |
| Offer codes | Not in Phase 1; reserved for coach and partner promotions in v1.1. Never unlock Premium with backend-only codes (guideline 3.1.1) | DESIGN.md §9.1 |
| Promotional offers, win-back offers | Not in Phase 1 | |

## 5. Small Business Program

- **Enroll before the first sale.** The 15% rate applies from 15 days after the end of the Apple fiscal month in which the enrollment is approved; sales before that pay 30% in a subscriber's first year (`docs/costs.md` §1).
- Eligibility: under $1M in proceeds in the previous calendar year, counting associated developer accounts.
- Without the program, subscriptions still drop to 15% after a subscriber's first paid year.

## 6. Disclosure text shown with the paywall

`SubscriptionStoreView` shows Apple's own price and renewal terms. If the paywall adds a footnote, use the same wording as the store description (`metadata.vi.md` / `metadata.en.md`, "Premium là gói đăng ký tự động gia hạn…" / "Premium is an auto-renewing…"). Rules (guideline 3.1.2, DESIGN.md §11):
- The billed amount is the most prominent price. The yearly "≈ X/tháng" caption is computed from `Product.price / 12` with `priceFormatStyle`, is smaller, and is never hard-coded.
- Quotas are stated exactly, from the server: "Premium: 15 phân tích nâng cao/tháng", "Dùng thử 7 ngày: tối đa 10 phân tích (5 nâng cao)", "Miễn phí: 2/tháng".
- Terms (EULA) and Privacy links, Restore Purchases and Redeem Code are visible in the paywall.

## 7. Quotas and models behind each plan (for reference)

| | Free | Trial (7 days, yearly only) | Premium |
|---|---|---|---|
| Analyses | 2 per calendar month (ICT); the first-ever one is advanced and counts toward the 2 | 10 in total; first 5 advanced, then basic | 15 per subscription month, advanced; windows start on the purchase day |
| Model | Haiku 5.5 (first-ever: Sonnet 5.5) | Sonnet 5.5, then Haiku 5.5 | Sonnet 5.5 |
| Refunds for rejected or partial results | Up to 3 per period | 3 | 3 |

Values live in `plan_limits` and `model_routes`; this table is documentation only.
