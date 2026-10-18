# Age rating questionnaire

Answers for App Store Connect › App Information › Age Rating, consistent with the in-app **18+ gate** (DESIGN.md D21: birth year in onboarding, `app_config.min_user_age = 18`) and with DESIGN.md §9.1 / §11. Apple's questionnaire wording changes from time to time; match each answer below to the closest current question and record any differences here.

## 1. Content questions

Answer from what the app actually contains. RacketCoach shows sports technique feedback and drills, with no user-to-user features.

| Question (App Store Connect) | Answer | Notes |
|---|---|---|
| Parental controls | No | |
| Age assurance | Yes | Self-declared birth year with an attestation at the threshold; under-18 users are blocked. Not a verified age check |
| Unrestricted web access | No | Links open only our legal and support pages |
| User-generated content | No | Users analyze their own clips privately; nothing is published or shared with other users |
| Messaging and chat | No | |
| Advertising | No | |
| Profanity or crude humor | None | |
| Horror or fear themes | None | |
| Alcohol, tobacco or drug use or references | None | |
| Mature or suggestive themes | None | |
| Sexual content or nudity (all variants) | None | |
| Violence (cartoon, realistic, prolonged graphic, weapons) | None | |
| Simulated gambling / gambling / contests / loot boxes | None / No | |
| Medical or treatment-focused information | None | Technique coaching only; fixed safety notes say "Stop if it hurts" and suggest asking a coach or professional, with no diagnosis or treatment |
| Health or wellness topics | No | The app is sports technique education. If App Review disagrees, answer Yes; it does not change the outcome below |
| Made for Kids | No | Never join the Kids category |

With these answers Apple computes the lowest tier (4+).

## 2. Age rating override: 18+

RacketCoach restricts use to adults for legal reasons (Vietnam's PDPL, and images sent to a third-party AI provider), not because of its content. To keep the store rating consistent with the in-app gate, use App Store Connect's option to **set a higher age rating** and choose **18+**.

- Explain it in the review notes if asked: "Content is suitable for all ages; the 18+ rating matches the in-app age gate required by our data-protection policy."
- If counsel later lowers `min_user_age` to 16 (DESIGN.md D21, gate G2), change the override to 16+ in the same release.
- Do not rely on the store rating alone: the in-app birth-year gate stays.

## 3. Vietnam rating (Decree 147/2024/ND-CP)

Apple shows a Vietnam-specific age rating (tiers 00+, 12+, 16+, 18+) derived from the questionnaire for apps distributed in Vietnam.

| ✓ | Step |
|---|---|
| [ ] | After saving the answers and the 18+ override, open the Vietnam rating shown in App Store Connect and confirm it is **18+** |
| [ ] | If App Store Connect asks Vietnam-specific questions, answer them consistently with section 1 and record the questions and answers here |
| [ ] | If the Vietnam rating cannot be raised to 18+, record the rating shown and ask counsel whether the in-app gate is sufficient |
| [ ] | Re-check whenever `min_user_age` changes |

## 4. Related settings

- Do not enable Family Sharing for the subscriptions (DESIGN.md §9.1).
- Phase 2 (US launch) requires the DeclaredAgeRange integration first (DESIGN.md §9.2, Utah and Louisiana rules).
