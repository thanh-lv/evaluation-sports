> **BẢN NHÁP – cần luật sư Việt Nam rà soát trước khi phát hành / DRAFT – requires review by Vietnamese counsel**

# PDPL and Vietnam compliance checklist – RacketCoach

Working checklist for the Vietnam launch (Phase 1, VN storefront only). Sources: DESIGN.md §11 and gates G1/G2, `docs/research/market-pricing-compliance.md` §5, `docs/costs.md` §4. Tick an item only when the evidence column points to something that exists. Owner codes: **U** = user / operator, **C** = counsel, **D** = developer.

Laws referenced: Personal Data Protection Law 91/2025/QH15 (PDPL, in force 1 Jan 2026); Decree 356/2025/ND-CP (replaces Decree 13/2023); Law on Artificial Intelligence 134/2025/QH15; Cybersecurity Law 116/2025/QH15; E-commerce Law 122/2025/QH15 and Decree 248/2026/ND-CP; Decree 147/2024/ND-CP (internet services, app age rating); Civil Code Art. 32 (image rights); Consumer Protection Law 2023.

## Gate G1 – before pricing is final and before launch

| ✓ | Item | Owner | Evidence |
|---|---|---|---|
| [ ] | Legal entity chosen (individual developer, household business or company); Apple account type matches | U | Registration papers; `docs/costs.md` §4 |
| [ ] | Tax and proceeds model for that entity type confirmed by a tax adviser; `docs/economics.md` updated | U | Adviser note; economics.md "Proceeds" table |
| [ ] | Data localisation answer (Cybersecurity Law 116/2025 and its decree) for the chosen entity; if required, contingency CT-1 (nightly encrypted export of user tables to VN-hosted storage) scheduled | C, D | Counsel memo; CT-1 ticket |
| [ ] | Ministry of Industry and Trade e-commerce app notification: required or not for an app that sells only its own service through IAP | C | Counsel memo; notification receipt if required |
| [ ] | Trademark "RacketCoach" (or the final name) filed in classes 9, 41, 42 (fee reductions end 31 Dec 2026) | U | Filing receipt |
| [ ] | Small business / startup exemptions under the PDPL assessed for the chosen entity (DPIA, data protection officer, CTIA); see `dpia.md` Q1 | C | Counsel memo |

## Gate G2 – before external TestFlight

| ✓ | Item | Owner | Evidence |
|---|---|---|---|
| [ ] | Counsel sign-off on the consent texts (a)–(d), subject and guardian attestations, age gate copy | C | Signed review of `consent-texts.vi.md` |
| [ ] | Counsel sign-off on the privacy policy, terms of use and AI disclosure (vi and en) | C | Signed review |
| [ ] | Age policy confirmed: 18+ at launch (`app_config.min_user_age = 18`). Lowering to 16 requires counsel sign-off **and** documented Anthropic minor safeguards | C, U | Counsel memo; app_config value |
| [ ] | DPIA completed on the official form and filed within the legal deadline | C, U | Filing receipt; `dpia.md` |
| [ ] | CTIA completed on the official form and filed with the Ministry of Public Security | C, U | Filing receipt; `ctia.md` |
| [ ] | Open questions Q1–Q7 in `dpia.md` answered | C | Counsel memo |

## PDPL core obligations

| ✓ | Item | Owner | Evidence |
|---|---|---|---|
| [ ] | Privacy notice in Vietnamese, reachable before consent and from Settings › Legal | D | `privacy-policy.vi.md` published at `https://{{LEGAL_HOST}}/vi/privacy` |
| [ ] | Consent is explicit, specific per purpose, never pre-ticked; required items (a) and (b) separate from optional (c) and (d) | D | Consent screen; `consent-texts.vi.md` |
| [ ] | Consent records keep version and server-set timestamp | D | `profiles.pdpl_consent_version/at`, `ai_consent_version/at` (trigger `stamp_profile_consents`) |
| [ ] | Consent re-requested when a version changes | D | `app_config.consent_versions`; `submit` returns 403 `consent_required` |
| [ ] | Withdrawal in the app, as easy as giving consent | D | Settings › Privacy |
| [ ] | Decide whether withdrawal of (a)/(b) must delete stored data (`dpia.md` Q4) and implement the answer | C, D | Counsel memo; app behavior |
| [ ] | Access, correction and deletion available in the app; copy-of-data requests handled by email within the legal deadline | D, U | History, Settings › Profile, Delete account; support procedure |
| [ ] | Account deletion works for anonymous and linked accounts, removes Storage recursively, revokes Sign in with Apple, keeps only a hashed audit row | D | `delete-account` tests; SQL check at M16 |
| [ ] | Processor agreements in place with Supabase, Anthropic and the email provider; subprocessor list in the privacy policy is current | U | Signed or accepted DPAs; privacy policy §6 |
| [ ] | Retention limits enforced automatically (DESIGN.md §6.6) | D | Daily cron: frames 72 h cap, `prepared` 24 h, orphans, pose 24 months inactivity, `llm_outputs` 90 days, `events` 13 months |
| [ ] | Retention for results and inactive accounts decided (`dpia.md` Q5) | C, U | Counsel memo; policy updated |
| [ ] | Classification of pose data (biometric or not) decided (`dpia.md` Q2) | C | Counsel memo |
| [ ] | Children: users 18+; filmed subjects under 16 need guardian attestation and run pose-only (no frames uploaded) | D | `subject_minor`, `frame_mode = pose_only`; device test |
| [ ] | Filming others: attestation required, enforced in the database, Terms clause, deletion channel for filmed people | D | `analyses_other_needs_consent` check; Terms §6; privacy policy §14 |
| [ ] | Bystanders: every non-target person masked; F5 cropped; fail-closed head blur | D | PrivacyMasker device tests (M13) |
| [ ] | Security: RLS on every table, column grants, Storage policies per bucket, no service key in the app, AES-GCM for Apple tokens, no PII in logs | D | SQL policy matrix tests; code review |
| [ ] | Data breach procedure written; notification to the Ministry of Public Security within the legal deadline | U, C | `dpia.md` §12 |
| [ ] | Data protection officer or responsible person designated, or exemption confirmed | U, C | Appointment record |
| [ ] | Records of processing kept (this checklist, DPIA, CTIA, data inventory) | U | This folder |

## AI, App Store and consumer items with a Vietnam angle

| ✓ | Item | Owner | Evidence |
|---|---|---|---|
| [ ] | "Nhận xét do AI tạo, có thể chưa chính xác" on every result, including the demo (AI Law 134/2025); implementing decree tracked | D, C | Results footer; counsel note |
| [ ] | AI disclosure page published (vi, en) | D | `ai-disclosure.*.md` |
| [ ] | No medical claims anywhere (app, store listing, support); no "phòng chấn thương", no "chuẩn như HLV" | D | Copy review; `appstore/metadata.*.md` |
| [ ] | Vietnam age rating (Decree 147) answered consistently with the 18+ gate | U | `appstore/age-rating.md` |
| [ ] | Consumption information sent to Apple only with `consumption_consent` | D | Webhook CONSUMPTION_REQUEST handling |
| [ ] | Subscription terms disclosed before purchase; Terms (EULA) linked in both store descriptions | D, U | Paywall; `appstore/metadata.*.md` |

## Before every release

| ✓ | Item | Owner |
|---|---|---|
| [ ] | Re-check Anthropic's API retention and training policy; update consent (b), privacy policy §8, AI disclosure §4; bump `consent_versions.ai` if the text changes | U, D |
| [ ] | Re-check Supabase region (ap-southeast-1) and subprocessors | U |
| [ ] | Any change to consent text → bump the matching `consent_versions` entry | D |
| [ ] | App Privacy label and `PrivacyInfo.xcprivacy` still match `appstore/privacy-label.md` | D |
| [ ] | Legal pages published at the URLs the app builds from `LEGAL_HOST` | U |
