# Documentation index

Start with **DESIGN.md** (v1.1, authoritative). Where it says "as in v1.0", read DESIGN-v1.0.md. Research files are background only.

## Design and engineering

| File | What it is |
|---|---|
| [DESIGN.md](DESIGN.md) | Implementation plan v1.1: decisions, scope, architecture, contracts, Claude integration, pricing, compliance, milestones |
| [DESIGN-v1.0.md](DESIGN-v1.0.md) | Base spec that v1.1 inherits from wherever it says "as in v1.0" |
| [design-review.md](design-review.md) | Technical and product/compliance critiques of v1.0 that led to v1.1 |
| [PLAN.vi.md](PLAN.vi.md) | Execution plan in Vietnamese |
| [CONTRACTS.md](CONTRACTS.md) | Cheat sheet of contract exports, file paths and HTTP status codes for contributors |
| [database.md](database.md) | Postgres schema, RLS, functions, Storage, cron and the demo reviewer (M5) |
| [glossary.md](glossary.md) | EN ↔ VI terminology table, every term pending coach review; copy-style rules |
| [economics.md](economics.md) | Per-analysis cost, proceeds after Apple, `standard_limit` rule, break-even conversion (estimates until M6) |
| [costs.md](costs.md) | Budget in Vietnamese: Apple, hardware, infrastructure, AI, legal and tax costs, with sources |

## Research (background, not authoritative)

| File | What it is |
|---|---|
| [research/sport-rubric.md](research/sport-rubric.md) | Biomechanics checkpoints per stroke, view dependence, Vietnamese sport terms |
| [research/ios-pose.md](research/ios-pose.md) | Apple Vision pose, video decoding, tracking and on-device performance |
| [research/backend-ai-subscriptions.md](research/backend-ai-subscriptions.md) | Supabase, Claude API and App Store subscription back end |
| [research/market-pricing-compliance.md](research/market-pricing-compliance.md) | Competitors, pricing, App Store review and Vietnamese law |

## User-facing guides

| File | What it is |
|---|---|
| [camera-guide.vi.md](camera-guide.vi.md) | Hướng dẫn đặt máy quay: 10 điểm, góc quay theo môn và kỹ thuật, 60 fps, mẹo trong ứng dụng |
| [camera-guide.en.md](camera-guide.en.md) | Camera setup guide (English), same structure and tip copy |
| [support/index.vi.md](support/index.vi.md) | Trang hỗ trợ (App Store Support URL): quay video, bị từ chối, lượt, khôi phục, xoá tài khoản, liên hệ |
| [support/index.en.md](support/index.en.md) | Support page (English) |

## Legal (all drafts – require review by Vietnamese counsel)

| File | What it is |
|---|---|
| [legal/privacy-policy.vi.md](legal/privacy-policy.vi.md) · [en](legal/privacy-policy.en.md) | Privacy policy under PDPL Law 91/2025: data, purposes, consent, transfers to Singapore and the USA, retention, rights |
| [legal/terms-of-use.vi.md](legal/terms-of-use.vi.md) · [en](legal/terms-of-use.en.md) | Terms of use / custom EULA: subscriptions, AI and medical disclaimers, acceptable use, Apple minimum terms |
| [legal/ai-disclosure.vi.md](legal/ai-disclosure.vi.md) · [en](legal/ai-disclosure.en.md) | How AI is used, which models, what is sent, limits (AI Law 134/2025, guideline 5.1.2(i)) |
| [legal/consent-texts.vi.md](legal/consent-texts.vi.md) · [en](legal/consent-texts.en.md) | Exact in-app strings with String Catalog keys: consents (a)–(d), subject and age gates, camera string, AI label, privacy and deletion screens |
| [legal/dpia.md](legal/dpia.md) | Data protection impact assessment draft (Vietnamese, English headings) |
| [legal/ctia.md](legal/ctia.md) | Cross-border transfer impact assessment draft (Vietnamese, English headings) |
| [legal/pdpl-checklist.md](legal/pdpl-checklist.md) | Gates G1/G2 and PDPL, AI-law and store checklist with owners and evidence |

## App Store

| File | What it is |
|---|---|
| [appstore/metadata.vi.md](appstore/metadata.vi.md) · [en](appstore/metadata.en.md) | Name, subtitle, promo text, description with subscription disclosure and EULA/Privacy links, keywords, what's new, screenshot captions |
| [appstore/review-notes.md](appstore/review-notes.md) | Notes for App Review (demo, sample clip, anonymous flow, reviewer flag, sandbox, AI disclosure) and the pre-submission checklist |
| [appstore/privacy-label.md](appstore/privacy-label.md) | App Privacy answers and the matching `PrivacyInfo.xcprivacy` entries |
| [appstore/age-rating.md](appstore/age-rating.md) | Age-rating questionnaire answers, 18+ override, Vietnam rating (Decree 147) |
| [appstore/subscriptions.md](appstore/subscriptions.md) | Subscription group, product IDs, VN prices to verify, trial, localized names, Small Business Program |

Planned: `rubric/calibration.md` (M17).

## Published pages

`docs/legal/*` and `docs/support/*` are published as static pages. The app builds these URLs in code from the `LEGAL_HOST` and `SUPPORT_HOST` xcconfig values (hosts only, never URLs in xcconfig):

| Page | Source | URL |
|---|---|---|
| Privacy policy | `legal/privacy-policy.{vi,en}.md` | `https://{LEGAL_HOST}/{vi,en}/privacy` |
| Terms of use (EULA) | `legal/terms-of-use.{vi,en}.md` | `https://{LEGAL_HOST}/{vi,en}/terms` |
| AI disclosure | `legal/ai-disclosure.{vi,en}.md` | `https://{LEGAL_HOST}/{vi,en}/ai` |
| Support | `support/index.{vi,en}.md` | `https://{SUPPORT_HOST}/{vi,en}/` |
| Camera guide | `camera-guide.{vi,en}.md` | `https://{SUPPORT_HOST}/{vi,en}/camera-guide` |

Not published: `consent-texts.*`, `dpia.md`, `ctia.md`, `pdpl-checklist.md`, `appstore/*`.

Before publishing, strip the `<!-- … -->` comments (they hold notes for counsel and maintainers), fill every placeholder, remove the draft banner only after counsel signs off, and check that each page renders its tables.

## Placeholders

| Placeholder | Meaning |
|---|---|
| `{{COMPANY_NAME}}`, `{{COMPANY_ADDRESS}}`, `{{COMPANY_REG_NO}}` | Legal name, address and registration or tax number of the operator (decided at gate G1) |
| `{{LEGAL_REPRESENTATIVE}}`, `{{DPO_CONTACT}}`, `{{COUNSEL_NAME}}` | People named in the DPIA and CTIA |
| `{{CONTACT_EMAIL}}` | Privacy and support contact |
| `{{LEGAL_HOST}}`, `{{SUPPORT_HOST}}` | Hosts of the legal and support pages (same values as the xcconfig) |
| `{{SUPABASE_HOST}}` | Supabase project host, for the App Store Server Notifications URL |
| `{{EFFECTIVE_DATE}}`, `{{CONSENT_VERSION}}`, `{{TERMS_VERSION}}` | Publication date and versions; `CONSENT_VERSION` matches `app_config.consent_versions` |
| `{{EMAIL_PROVIDER}}`, `{{EMAIL_PROVIDER_COUNTRY}}` | SMTP provider for email OTP (for example Resend, USA) |
| `{{INFRA_LOG_RETENTION}}` | Supabase log retention for the chosen plan |
| `{{REVIEWER_EMAIL}}`, `{{REVIEWER_MAILBOX_URL}}` | App Review demo account and its mailbox |
| `{{SUPPORT_RESPONSE_DAYS}}`, `{{DSR_RESPONSE_DAYS}}` | Support reply target; legal deadline for data-subject requests |
| Others in `dpia.md` / `ctia.md` | Dossier metadata, DPA references, counts; filled when the dossiers are prepared |

"RacketCoach" is the working name (DESIGN.md §15). If the final name differs, replace it in every user-facing file.

## Writing conventions

- Vietnamese copy addresses the user as "bạn", uses full diacritics, and follows [glossary.md](glossary.md). English copy uses US spelling.
- No medical claims anywhere: never "phòng chấn thương" / "injury prevention", never "chuẩn như HLV", no DUPR or club "trình" claims.
- Face blur is always described as best effort ("ở mức tốt nhất có thể"), never "all faces".
- Numbers that the server owns (quotas, prices, retention) must match DESIGN.md §6.6 and §9; when they change, update the legal pages, support pages, store metadata and `economics.md` together.
