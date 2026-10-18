# App Privacy label (App Store Connect) and privacy manifest

Answers for App Store Connect › App Privacy, aligned with DESIGN.md §11 (row "Privacy manifest and label") and with `ios/RacketCoach/Resources/PrivacyInfo.xcprivacy`. The two must declare the same data types. Re-check before every submission (`review-notes.md` part B).

## 1. Top-level answers

| Question | Answer |
|---|---|
| Do you or your third-party partners collect data from this app? | **Yes** |
| Is any data used to track users? | **No**. `NSPrivacyTracking = false`; no tracking domains; no IDFA; no App Tracking Transparency prompt |
| Privacy Policy URL | `https://{{LEGAL_HOST}}/vi/privacy` (vi), `https://{{LEGAL_HOST}}/en/privacy` (en) |
| User privacy choices URL (optional) | Leave empty; the privacy policy (section "Quyền của bạn" / "Your rights") covers it |

"Collected" here means sent off the device and kept longer than needed to answer the request in real time. Key frames are kept up to 72 hours, so they count as collected.

## 2. Data types collected

Every type below is **linked to the user** (it sits under the user's ID) and **not used for tracking**.

| Apple category › type | What it is in RacketCoach | Purposes | Manifest constant |
|---|---|---|---|
| Contact Info › **Email Address** | Only if the user links an email or Sign in with Apple shares one | App Functionality | `NSPrivacyCollectedDataTypeEmailAddress` |
| Identifiers › **User ID** | Supabase user ID (anonymous or linked); `appAccountToken` sent to Apple | App Functionality | `NSPrivacyCollectedDataTypeUserID` |
| User Content › **Photos or Videos** | Up to 5 face-blurred key frames per analysis (never the video) | App Functionality | `NSPrivacyCollectedDataTypePhotosorVideos` |
| User Content › **Other User Content** | Pose data (joint coordinates), feedback comments | App Functionality; Other Purposes (accuracy calibration, only with opt-in (c)) | `NSPrivacyCollectedDataTypeOtherUserContent` |
| Health & Fitness › **Fitness** | Technique scores and exercise-related data derived from strokes (declared conservatively) | App Functionality | `NSPrivacyCollectedDataTypeFitness` |
| Purchases › **Purchase History** | Subscription status and transactions from Apple | App Functionality | `NSPrivacyCollectedDataTypePurchaseHistory` |
| Usage Data › **Product Interaction** | First-party events (`log_event` allowlist: screens opened, analyses submitted, paywall viewed…) | Analytics; App Functionality | `NSPrivacyCollectedDataTypeProductInteraction` |
| Usage Data › **Other Usage Data** | Credit counters, thumbs feedback, consent and opt-in state | Analytics; App Functionality | `NSPrivacyCollectedDataTypeOtherUsageData` |

In the manifest, each entry has `NSPrivacyCollectedDataTypeLinked = true` and `NSPrivacyCollectedDataTypeTracking = false`. Purpose constants: `NSPrivacyCollectedDataTypePurposeAppFunctionality`, `NSPrivacyCollectedDataTypePurposeAnalytics`, `NSPrivacyCollectedDataTypePurposeOther`.

## 3. Data types not collected

Answer **No** for: Name (there is no display name), Phone Number, Physical Address, Other Contact Info; Health (only Fitness is declared); Financial Info (Apple handles payment); Location; Sensitive Info; Contacts; Emails or Text Messages; **Audio Data** (no microphone); Gameplay Content; Customer Support (support happens by email, outside the app); Browsing History; Search History; Device ID (DeviceCheck returns an Apple-held bit, and we never read or store a device identifier); Crash Data, Performance Data, Other Diagnostic Data (no crash or performance SDK; crash reports that users share with developers through Apple are Apple's collection); Advertising Data; Other Data Types.

If a crash-reporting SDK is ever added, declare Diagnostics before shipping it.

## 4. Required-reason APIs (manifest `NSPrivacyAccessedAPITypes`)

| API category | Reason code | Why |
|---|---|---|
| `NSPrivacyAccessedAPICategoryUserDefaults` | `CA92.1` | App settings (language, guide seen, onboarding state) |
| `NSPrivacyAccessedAPICategoryFileTimestamp` | `C617.1` | Age of local videos for the 60-day clean-up, inside the app container |
| `NSPrivacyAccessedAPICategoryDiskSpace` | `E174.1` | Free-space check before recording or importing |

Not used: system boot time (`systemUptime`, `mach_absolute_time`; the app uses `ContinuousClock`), active keyboards. supabase-swift 2.55.3 must ship its own privacy manifest; confirm it in the built app's privacy report (Xcode › Product › Archive › Generate Privacy Report).

## 5. Consistency checks

- The privacy policy (§3) lists the same categories; no category here is missing from it.
- The consent screen states where key frames and pose data go (Supabase Singapore, Anthropic USA).
- The camera usage string matches DESIGN.md §10.1 and never says "all faces".
- Optional opt-ins (c) and (d) do not add new data types; they add purposes (Other Purposes) or recipients (Apple, for refund requests).
