# Unit economics

How much one analysis costs, what a subscriber brings in, and how the premium quota (`standard_limit`) is set. Sources: DESIGN.md §1.1, §8.7, §9.2–9.3; `docs/costs.md` §1, §3; Claude prices checked against the claude-api reference (cached 2026-10-06).

**Status: every figure below is an estimate (est.)** until the M6 live smoke test measures real token counts and costs. Section 9 is where measured values go. Exchange rate: **1 USD = 26,000₫** (`docs/costs.md`).

## 1. Prices

| Plan | Vietnam price | Notes |
|---|---|---|
| Monthly | 79,000₫ | Must exist as an App Store price point (`appstore/subscriptions.md`) |
| Yearly | 599,000₫ (≈ 49,900₫/month) | 7-day free trial on yearly only |
| Phase 2 base | $9.99 / $59.99 | Not modeled here |

## 2. Proceeds per subscriber

App Store VND prices include VAT. Apple then takes its commission, and for Vietnamese individual developers also withholds PIT and FCT. The exact model depends on the legal entity chosen at gate G1.

| Model | Formula | Monthly plan | Yearly plan (per month) |
|---|---|---|---|
| **DESIGN.md baseline** (10% VAT, 15% commission) | price ÷ 1.10 × 0.85 | **61,045₫ ≈ $2.35** | **38,572₫ ≈ $1.48** |
| Individual developer, VAT 10% (`costs.md`) | price ÷ 1.10 × (1 − 0.15 − 0.0075 − 0.02) | 59,070₫ ≈ $2.27 | 37,324₫ ≈ $1.44 |
| Individual developer, VAT 5% | price ÷ 1.05 × 0.8225 | 61,883₫ ≈ $2.38 | 39,101₫ ≈ $1.50 |
| No Small Business Program, first year (VAT 10%) | price ÷ 1.10 × (1 − 0.30 − 0.015 − 0.02) | 47,759₫ ≈ $1.84 | 30,177₫ ≈ $1.16 |

The rest of this page uses the **baseline** ($2.35 and $1.48). The yearly plan brings in about 37% less per month than the monthly plan, so the yearly plan is the binding case for the quota. Enroll in the Small Business Program before the first sale: without it, yearly proceeds fall to about $1.16/month, the worst-case Premium margin in section 5 drops from 36% to about 18%, and `standard_limit` (section 6) falls to 14.

## 3. Claude prices (per million tokens)

| Model | Input | Output | Cache read | Cache write (5 min) |
|---|---|---|---|---|
| Sonnet 5.5 (`standard`) | $2.00 | $10.00 | $0.20 | $2.50 |
| Haiku 5.5 (`basic`, prompts ≤ 100K tokens) | $0.10 | $0.50 | $0.01 | $0.125 |

`docs/costs.md` lists $0.10 for Sonnet 5.5 cache reads; DESIGN.md and the API reference say $0.20. The difference is about $0.0007 per analysis (7K cached tokens) and does not change any conclusion. Haiku 5.5's tokenizer counts about 30% more tokens, so Haiku token counts below are multiplied by 1.3.

## 4. Cost per analysis (est.)

Assumptions (DESIGN.md §8.7): cached system prompt and rubric ≈ 7K tokens; uncached input ≈ 6.4K (5 frames × ≈ 588 + ≈ 3.5K of tables); JSON output ≈ 2.5K; thinking ≈ 0.8K at Sonnet `low`, 2.5K at Sonnet `medium`, 1.5K at Haiku `medium`. "Warm" means the system prefix is read from cache; "cold" means it is written to cache on this call.

| Route | Warm | Cold | VND |
|---|---|---|---|
| Sonnet 5.5 `low` (launch setting) | 6.4K×$2 + 7K×$0.20 + 3.3K×$10 ≈ **$0.047** | 7K at $2.50 instead ≈ **$0.063** | 1,220–1,640₫ |
| Sonnet 5.5 `medium` | ≈ $0.064 | ≈ $0.080 | 1,660–2,080₫ |
| Haiku 5.5 `medium` | 8.3K×$0.10 + 9.1K×$0.01 + 5.2K×$0.50 ≈ **$0.0035** | ≈ $0.0045 | 90–120₫ |

Infrastructure cost per analysis (Supabase storage, egress, function calls) is inside the Pro plan quota at launch scale and is treated as a fixed cost (section 7).

## 5. Monthly AI cost per user (est.)

| User | Usage | AI cost / month | Against proceeds |
|---|---|---|---|
| Premium, typical | ≈ 6 advanced analyses | ≈ $0.28–0.38 (DESIGN.md uses **$0.30**) | 13% of monthly, 20% of yearly proceeds |
| Premium, worst case | 15 advanced, all cold | 15 × $0.063 = **$0.95** | 40% of monthly; **64% of yearly → 36% margin** |
| Trial, worst case | 5 advanced + 5 basic | 5 × $0.063 + 5 × $0.0045 ≈ **$0.34** | Acquisition cost; recovered from the first yearly payment |
| Free, first month | First-ever advanced + 1 basic | ≈ $0.063 + $0.0045 ≈ **$0.07** | Acquisition cost |
| Free, later months | Up to 2 basic | ≤ $0.009 | |

Rejected or partial results are refunded to the user (up to 3 per period) but the Claude call is still paid; the quota math above assumes they are rare. Track the refund rate in `events`.

## 6. The `standard_limit` rule

Premium gets `standard_limit` advanced (Sonnet) analyses per subscription month; anything above it, up to `total_limit`, runs on Haiku. The rule (DESIGN.md §9.3), applied after the M6 smoke test and reviewed monthly:

```
standard_limit = min(15, floor(0.8 × VN-yearly proceeds per month ÷ measured p90 Sonnet cost))
```

The 0.8 keeps at least 20% of yearly proceeds even if a subscriber uses every advanced analysis at p90 cost.

| Yearly proceeds / month | p90 Sonnet cost | 0.8 × proceeds ÷ cost | `standard_limit` |
|---|---|---|---|
| $1.48 (baseline) | $0.047 (warm, `low`) | 25.2 | **15** |
| $1.48 | $0.063 (cold, `low`) | 18.8 | **15** |
| $1.48 | $0.080 (cold, `medium`) | 14.8 | **14** |
| $1.48 | $0.095 (v1.0 estimate, 9 frames) | 12.5 | **12** |
| $1.44 (individual, VAT 10%) | $0.063 | 18.2 | **15** |
| $1.44 | $0.080 | 14.4 | **14** |

**Threshold:** the limit stays at 15 while p90 Sonnet cost is **≤ $0.079** at baseline proceeds (≤ $0.077 for an individual developer at 10% VAT). Moving the standard route from `low` to `medium` effort is what would push it below 15. When the limit drops, the remainder becomes Haiku analyses and the paywall copy updates from `plan_limits`; the store descriptions carry no numbers on purpose (`appstore/subscriptions.md` §3).

## 7. Fixed monthly costs at launch (est.)

| Item | Per month | Source |
|---|---|---|
| Supabase Pro | $25.00 (650,000₫) | `costs.md` §1 |
| Apple Developer Program ($99/year) | $8.25 (214,500₫) | `costs.md` §1 |
| Domain (.com, $11.17/year) | $0.93 (24,200₫) | `costs.md` §1 |
| Email OTP (Resend free tier) | $0 | `costs.md` §1 |
| **Total** | **≈ $34.20 (≈ 889,000₫)** | |

Not included: legal advice (PDPL dossiers, est. 15–60M₫ one-off), trademark, marketing, coach time, hardware. See `costs.md` §4–6.

## 8. Break-even conversion (est.)

Paying share of monthly active users (MAU) needed to cover fixed costs plus all AI costs.

Assumptions: free MAU cost $0.023/month each (30% are new users who get the first-ever advanced analysis plus about one basic analysis; the rest average one basic analysis); paying users at the typical ($0.30) or worst-case ($0.95) Premium cost; fixed costs $34.20.

`break-even share = (fixed + MAU × free cost) ÷ (MAU × (proceeds − paid cost + free cost))`

| MAU | Plan mix | Typical usage | Worst-case usage |
|---|---|---|---|
| 1,000 | All monthly | **2.8%** | 4.0% |
| 1,000 | All yearly | **4.7%** | 10.2% |
| 10,000 | All monthly | **1.3%** | 1.8% |
| 10,000 | All yearly | **2.2%** | 4.7% |

AI costs alone (ignoring fixed costs) break even at 1.1–1.9% paying users with typical usage. Worked example: 1,000 MAU at 3% paying, typical usage, nets about +$5/month (+136,000₫) if everyone is on the monthly plan and about −$21/month (−538,000₫) if everyone is on the yearly plan. `costs.md` §3 reaches similar ranges (3.0–4.7% at 1K MAU with Sonnet for free users) under slightly different assumptions (no thinking tokens, Sonnet for one free analysis every month).

**Reading:** at launch scale the fixed Supabase cost dominates, not Claude. The yearly plan needs roughly 1.7× the conversion of the monthly plan. Cost per heavy user is capped by `standard_limit`, so the worst case stays positive on every plan once the Small Business Program applies.

## 9. Spend controls (DESIGN.md §8.7)

- Daily budget `app_config.budget_usd` (starts at $30). At 70%: alert, and free advanced requests downgrade to basic. At 100%: free submits get 503 `busy_try_later` with no quota reserved. Paid, trial and reviewer accounts are always served, up to a hard 2× cap.
- Alert when a user's monthly LLM cost exceeds 60% of estimated proceeds (`user_monthly_cost`).
- Dedicated Anthropic workspace with a monthly spend limit.
- One in-flight analysis per user; idempotent submit; every attempt's cost logged in `private.llm_calls` from the four usage meters at the served model's price.

## 10. Measurements log

Fill in after each measurement; recompute sections 4–8 and `standard_limit` from these numbers.

| Date | Milestone | Route | Calls | p50 cost | p90 cost | Cache read seen | Notes |
|---|---|---|---|---|---|---|---|
| {{DATE}} | M6 smoke test (≈ $0.50, needs approval) | Sonnet `low` / Haiku `medium`, both sports | | | | | |
| {{DATE}} | M17 effort re-sweep | | | | | | |
| {{DATE}} | First month in production | | | | | | Also record refund rate, plan mix, conversion |
