> **BẢN NHÁP – cần luật sư Việt Nam rà soát trước khi phát hành / DRAFT – requires review by Vietnamese counsel**

# AI Disclosure – RacketCoach

Version: {{CONSENT_VERSION}} · Effective: {{EFFECTIVE_DATE}}
Vietnamese version: https://{{LEGAL_HOST}}/vi/ai

<!--
Notes (not shown when published):
- Basis: Law on Artificial Intelligence No. 134/2025/QH15 (labelling of AI-generated content; track the implementing decree) and App Store Review Guideline 5.1.2(i).
- Technical source: DESIGN.md D2, D10, §8.1, §8.4, §8.6. When model_routes changes, update section 3.
-->

## 1. Summary

RacketCoach uses AI to write feedback on your technique. Every result carries the label **"AI-generated feedback, may be inaccurate"**. Results are for practice guidance only, are **not medical advice**, and do not replace a coach.

## 2. Who does what in an analysis

| Step | Done by | What happens |
|---|---|---|
| Pose detection | Your iPhone (Apple Vision) | Finds 19 body joints in each frame. The video never leaves your iPhone |
| Masking and blurring | Your iPhone | Masks everyone except the player; blurs faces on a best-effort basis; crops up to 5 still images |
| Measuring and scoring | Our servers (fixed program code) | Splits the clip into strokes, measures angles, heights and speeds, and compares them with the scoring rubric; **every number and score is computed by code** |
| Feedback | **Claude** (AI by Anthropic PBC, USA) | Judges points that can only be seen in images (for example racket-face angle) on a 0–4 scale or "can't assess"; chooses strengths and weaknesses **from the measured evidence**; writes the feedback, cues and practice plan in your chosen language |
| Checking | Our servers | Removes findings without measured evidence, strips numbers from the AI's wording, filters medical terms, and adds fixed safety notes |
| Rubric design | People | The rubric and drills are written from coaching material and calibrated on real clips labeled by a coach |

## 3. AI models used

| Analysis type | Model | When |
|---|---|---|
| Advanced analysis | Claude Sonnet 5.5 | Premium; the first 5 trial analyses; your first free analysis |
| Basic analysis | Claude Haiku 5.5 | Other free analyses; trial analyses after the 5 advanced ones |

We may change model versions to improve quality or cost; this page is updated when we do.

## 4. Data sent to the AI

For each analysis we send Anthropic: a table of measurements from your pose data, **up to 5 still images** (faces blurred on a best-effort basis, other people masked), sport, skill, handedness, level and camera view. **No video**, email, birth year or user ID is sent. If the person filmed is under 16, **no images are sent**; the AI receives pose measurements only.

Under Anthropic's current policy, data sent through its API is deleted automatically within 30 days (up to 2 years if its safety systems flag it for a usage-policy violation) and is **not used to train its models**. We only send data after you consent; you can withdraw consent in **Settings › Privacy**.

## 5. Limits you should know

- The app sees your body in 2D from **one** camera. Some points cannot be measured from some views; the app then says "Can't assess from this video".
- The contact moment is an **estimate** based on wrist speed.
- Scores are in **beta** and rounded to 5 points. Don't compare scores between different people or different camera views.
- The AI can be wrong, especially with dark, distant or partly hidden clips. Compare the feedback with how the stroke feels and ask a coach when needed.
- The AI does not diagnose injuries or medical conditions. If something hurts, stop and ask a coach or a professional.
- Results are not used for any decision that affects your legal rights, and are not used for advertising.

## 6. Language

The AI writes feedback in the language you chose when you submitted the analysis (Vietnamese or English). If you later switch the app language, older feedback keeps its original language and the app tells you so.

## 7. Feedback and reporting problems

Every result has thumbs up/down buttons. If a piece of feedback is wrong or inappropriate, email {{CONTACT_EMAIL}}. Your feedback helps us tune the rubric and the AI's instructions.
