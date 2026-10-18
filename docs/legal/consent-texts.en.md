> **BẢN NHÁP – cần luật sư Việt Nam rà soát trước khi phát hành / DRAFT – requires review by Vietnamese counsel**

# In-app consent and notice texts (English)

These are the **exact strings** used in the app. Edit them here first, then copy them into `Localizable.xcstrings` / `InfoPlist.xcstrings`; the Vietnamese counterparts are in `consent-texts.vi.md` under the same keys. The "Key" column holds the suggested String Catalog key.

**Rules** (DESIGN.md §2.2 step 5, §11):
- The consent screen appears just before the first analysis is submitted and blocks until the user chooses; it appears again whenever a consent version changes.
- Nothing is pre-ticked. "Agree and continue" is enabled only when **(a)** and **(b)** are ticked.
- (a) is stored in `profiles.pdpl_consent_version` and (b) in `profiles.ai_consent_version`, using the current versions in `app_config.consent_versions` (now `{"pdpl": "2026-10-01", "ai": "2026-10-01"}`). (c) is stored in `calibration_opt_in` and (d) in `consumption_consent`.
- Changing the text of (a) bumps `consent_versions.pdpl`; changing (b) bumps `consent_versions.ai`. The server returns 403 `consent_required` when a stored version is no longer current.
- Anthropic's retention period in (b) must match the privacy policy; re-check it right before release.

## 1. Consent screen before the first analysis

| Key | Display text |
|---|---|
| `consent.title` | Before your first analysis |
| `consent.intro` | For the AI to review your strokes, we need your consent. The first two items are required; the last two are up to you. |
| `consent.reconsent.title` | We've updated how we handle your data |
| `consent.reconsent.intro` | Please review and agree to keep analyzing. |

### (a) Required: processing and transfer outside Vietnam

| Key | Display text |
|---|---|
| `consent.pdpl.title` | Data processing and storage in Singapore (required) |
| `consent.pdpl.body` | We process pose data (the positions of your body joints over time), up to 5 still images and the details you choose (sport, skill, camera view, handedness, level) to analyze your strokes and keep your history. The data is stored on Supabase servers in Singapore, which means it is transferred outside Vietnam. Still images are deleted as soon as the analysis finishes, at the latest after 72 hours. Pose data and results are kept until you delete the analysis or your account; pose data is deleted automatically after 24 months without using the app. |
| `consent.pdpl.checkbox` | I agree to the processing and the transfer to Singapore described above. |

### (b) Required: AI analysis by Anthropic (Claude, USA)

| Key | Display text |
|---|---|
| `consent.ai.title` | AI analysis by Anthropic (Claude, USA) (required) |
| `consent.ai.body` | Your feedback is written by Claude, an AI model made by Anthropic PBC in the USA. For each analysis we send Anthropic:<br>• the pose coordinates of your strokes;<br>• up to 5 still images, with faces automatically blurred (best effort, which cannot be guaranteed in every case) and other people masked;<br>• sport, skill, camera view, handedness and level.<br>Your video is never uploaded. We delete the still images as soon as the analysis finishes, at the latest after 72 hours. Under Anthropic's current policy, data sent through its API is deleted automatically within 30 days (longer if flagged for a usage-policy violation) and is not used to train AI models.<br>You can withdraw consent at any time in Settings › Privacy; you then won't be able to start new analyses. |
| `consent.ai.checkbox` | I agree to send the data above to Anthropic in the USA for AI analysis. |

`<br>` is a line break; each "•" line is a list item.

### (c) Optional, off by default: accuracy improvement

| Key | Display text |
|---|---|
| `consent.calibration.title` | Improve accuracy (optional) |
| `consent.calibration.toggle` | Allow anonymized data to be used to improve accuracy |
| `consent.calibration.body` | If you turn this on, we may use your pose data and analysis results, with identifying information removed and without images, to calibrate the scoring and check quality. You can turn it off at any time in Settings › Privacy. |

### (d) Optional, off by default: sharing usage information with Apple on refund requests

| Key | Display text |
|---|---|
| `consent.consumption.title` | Share with Apple on refund requests (optional) |
| `consent.consumption.toggle` | Allow sending usage information to Apple when I request a refund |
| `consent.consumption.body` | When you ask Apple for a refund of Premium, Apple may ask us how you used the service. If you turn this on, we send Apple a summary such as how much of the service you used, how long you have used it and your in-app purchase history; we never send images, pose data or feedback content. If you leave it off, we send nothing. |

### Buttons and links

| Key | Display text |
|---|---|
| `consent.button.accept` | Agree and continue |
| `consent.button.later` | Not now |
| `consent.required_hint` | Tick both required items to continue. |
| `consent.declined.message` | You can still view the sample analysis. To analyze your own videos, agree to the two required items. |
| `consent.link.privacy` | Privacy Policy |
| `consent.link.ai` | AI Disclosure |

## 2. Filming someone else (the "Who is in the video" step)

| Key | Display text |
|---|---|
| `subject.title` | Who is in the video? |
| `subject.self` | Me |
| `subject.other` | Someone else |
| `subject.other.consent` | The person in the video agreed to be filmed and analyzed by me |
| `subject.minor.question` | Is the person in the video under 16? |
| `subject.minor.yes` | Yes |
| `subject.minor.no` | No |
| `subject.minor.guardian` | I am this person's parent or legal guardian, or I have their parent's or guardian's consent. |
| `subject.minor.pose_only_note` | For people under 16, the app sends pose data only and no images. Some points that need images won't be assessed. |

Continue is enabled only when `subject.other.consent` is ticked (and `subject.minor.guardian` when "Yes" is chosen).

## 3. Age ("About you" screen)

| Key | Display text |
|---|---|
| `about.birth_year.title` | What year were you born? |
| `about.age.blocked` | Sorry, RacketCoach is currently only for people aged %lld and over. |
| `about.age.attest` | I confirm that I am at least %lld years old. |

`%lld` comes from `app_config.min_user_age` (now 18). The confirmation checkbox only appears when the birth year is exactly at the threshold (the user may not have had their birthday yet).

## 4. Camera permission (`NSCameraUsageDescription`, InfoPlist.xcstrings)

> RacketCoach uses the camera to record your strokes. The video is analyzed on your iPhone and never uploaded. Only pose data and up to 5 still images (faces automatically blurred) are sent for AI analysis, after you agree.

This text is verbatim from DESIGN.md §10.1; don't change it without updating the design.

## 5. AI label and safety notes on results

| Key | Display text |
|---|---|
| `results.footer.ai_label` | AI-generated feedback, may be inaccurate · Not medical advice. Stop if it hurts. |
| `results.language_note` | This feedback was written in Vietnamese |
| `results.partial` | Not enough data — no credit used |
| `results.score.beta` | beta |
| `settings.legal.not_medical` | Not medical advice |

`results.footer.ai_label` must appear on **every** result, including the sample analysis (AI Law 134/2025).

## 6. Settings › Privacy

| Key | Display text |
|---|---|
| `settings.privacy.title` | Privacy |
| `settings.privacy.pdpl.row` | Data processing and storage in Singapore |
| `settings.privacy.ai.row` | AI analysis by Anthropic |
| `settings.privacy.accepted_on` | Agreed on %@ |
| `settings.privacy.not_accepted` | Not agreed |
| `settings.privacy.what_we_send` | What we send |
| `settings.privacy.withdraw` | Withdraw consent |
| `settings.privacy.withdraw.title` | Withdraw consent? |
| `settings.privacy.withdraw.body` | You won't be able to start new analyses until you agree again. Your history and stored data remain until you delete the analyses or your account. |
| `settings.privacy.withdraw.confirm` | Withdraw |
| `common.cancel` | Cancel |

**"What we send" screen** (`settings.privacy.what_we_send.body`):

> **Never sent:** video, audio, location, contacts.
> **Sent to our servers in Singapore:** pose data, up to 5 still images (faces blurred on a best-effort basis, other people masked), sport, skill, camera view, handedness, level, birth year; your email if you link an account.
> **Sent to Anthropic (USA) for AI feedback:** measured pose data, up to 5 still images, sport, skill, camera view, handedness, level. No email, birth year or user ID.
> **People under 16:** no images are sent, only pose data.
> **Still images** are deleted as soon as the analysis finishes, at the latest after 72 hours.

## 7. Deleting the account

| Key | Display text |
|---|---|
| `settings.delete.row` | Delete account |
| `settings.delete.title` | Delete your account? |
| `settings.delete.body` | All your analysis history, pose data, profile and consent choices will be permanently deleted and cannot be recovered. |
| `settings.delete.subscription_notice` | Your Premium subscription keeps renewing until you cancel it in iPhone Settings › [your name] › Subscriptions. Deleting your account does not cancel it. |
| `settings.delete.manage_subscription` | Manage subscription |
| `settings.delete.confirm` | Delete permanently |
| `settings.delete.done` | Your account has been deleted. |
| `settings.delete.siwa_manual` | To fully disconnect Sign in with Apple, go to iPhone Settings › [your name] › Sign-In & Security › Sign in with Apple, choose RacketCoach and stop using it. |

Show `settings.delete.subscription_notice` when the server returns `hadActiveSubscription: true` or StoreKit reports an active subscription; show `settings.delete.siwa_manual` when the server returns `siwaManualRevoke: true`.
