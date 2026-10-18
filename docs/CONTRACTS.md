# Contract cheat sheet (for contributors and agents)

Import everything from `@shared/contracts/index.ts`. Run Deno with `--config supabase/functions/deno.json`. Tests live in `supabase/tests/**`; regenerate schemas with `make schemas`.

**common.ts**
- Enums: `Sport`, `SkillId` (`bd.*`/`pb.*`), `sportOfSkill`, `Handedness`, `Level`, `Language`, `Subject`, `FrameMode`, `Tier`, `AnalysisKind` (basic/standard), `AnalysisStatus`.
- Views: `CameraView` (includes `auto`), `ConfirmedCameraView`. `VIEW_CODES` is S/B/D/F. `viewFactorColumn(view)` returns `{column, mirrorLateral}`; front uses the B column, mirrored.
- Skeleton: `JOINT_ORDER`, `Joint`, `JOINT_INDEX`, `KP_PER_FRAME` = 57.
- Phases: `SUB_SCORE_KEYS`, `STROKE_PHASES`, `ENGINE_PHASES`, `FRAME_PHASES` (adds `overview`).
- Frames: `FRAME_IDS`, `UPLOAD_FRAME_IDS`, `LOCAL_FRAME_IDS`, `BEST_FRAME_BY_PHASE`, `WORST_FRAME_BY_PHASE`, `OVERVIEW_FRAME_ID` = F5.
- Value types: `LocalizedText`, `NormRect`, `MicroSeconds`, `LowerUuid`.
- Errors:
  - `API_ERROR_STATUS` and `httpStatusFor`.
  - `ApiError` is `{code, message?, tips?, limit?, used?, resetsAt?}`; build it with `apiError(code, msg?, tips?, extra?)`.
  - `PREPARE_REJECTION_CODES` (422), `isPrepareRejection`, `FAILURE_CODES` (`model_refusal`, `bad_output`, `upstream_unavailable`, `bad_request`, `expired`, `internal`), `RESULT_REJECTION_CODES`.
- Tips: `TIP_KEYS` and `REJECTION_TIPS`. iOS and the Web Lab must define every key in `TIP_KEYS`.
- HTTP status for each code:

| Status | Codes |
|---|---|
| 422 | `invalid_payload`, every prepare rejection, `frames_missing` |
| 401 | `unauthorized` |
| 402 | `quota_exceeded` |
| 403 | `consent_required`, `forbidden` |
| 404 | `analysis_not_found`, `not_found` |
| 405 | `method_not_allowed` |
| 409 | `analysis_conflict`, `linked_to_other_account` |
| 413 | `payload_too_large` |
| 429 | `in_flight`, `rate_limited`, `transfer_rate_limited` |
| 500 | `internal` |
| 502 | `upstream_unavailable` |
| 503 | `busy_try_later` |

**Request and response documents**
- `pose_v1.ts`:
  - `PoseV1` runs every check; `PoseV1Structure` is the bare shape used for schema export.
  - `validatePoseAgainstCatalog(pose, Map<skill, sport>)`, `frameModeForPose`.
  - Constants: `POSE_V1_MAX_BYTES`, `ANALYSIS_HZ`, `MIN_SEGMENT_MS`/`MAX_SEGMENT_MS` (3000/32000), `FLAG_COASTED`/`FLAG_REACQUIRED`.
- `reprepare_v1.ts`: `ReprepareV1` is `{schema, analysisId, cameraView, excludedStrokeIds, handedness}`.
- `prepare_v1.ts`:
  - `PrepareResponseV1` (schema `prepare.v1`, invariants checked).
  - Parts: `PreparedStroke` (`excluded` flag, `thumbTUs`), `FrameRequest` (`frameId`, `strokeId`, `phase`, `tUs`, `crop`, `upload`), `QuotaPreview`, `StrokePhasesUs`, `StrokeRole`.
  - `PREPARE_WARNINGS`, `MAX_STROKES` = 12, `expectedUploadCount`, `prepareRequestKind`.
- `clean_track.ts`:
  - `CleanTrackV1` is `pose.clean.json`.
  - Coordinates are float CFS 0–1000 on a uniform grid with `t0Us`.
  - `interp` is a 19-bit mask per frame; read it with `isInterpolated`.
- `api_v1.ts` (new):

| Route | Request | Response |
|---|---|---|
| `GET /analyze/catalog` | — | `CatalogResponseV1`: schema `catalog.v1`; `skills[]` with `id`, `sport`, `name`, `views`, `viewCoverage`, `solo`; `plans[]` with `tier`, `periodType`, `totalLimit`, `standardLimit` |
| `POST /analyze/submit` | `SubmitRequest` `{analysisId, deviceCheckToken?}` | `SubmitResponse` `{status: queued \| processing \| succeeded, pollAfterMs}` |
| `POST /verify-subscription` | `VerifySubscriptionRequest` `{signedTransaction, reason: purchase \| restore \| launch \| update}` | `VerifySubscriptionResponse` `{tier, productId, expiresAt, willRenew, inGrace, billingIssue, isTrial, transferred}` |
| `POST /apple-auth-exchange` | `AppleAuthExchangeRequest` | — |
| `POST /account-merge` | `AccountMergeRequest` `{anonAccessToken}` | `AccountMergeResponse` `{merged}` |
| `POST /delete-account` | `DeleteAccountRequest` `{confirm: true}` | `DeleteAccountResponse` `{deleted, hadActiveSubscription, siwaManualRevoke}` |

**Claude output (`coach_output.ts`)**
- Build the schema with `buildCoachOutputSchema(coachSchemaCatalogFromRubric(loadRubric(sport)))`.
- `$defs`:
  - Enums: `SchemaVersion`, `Language`, `CheckpointId`, `VisualCheckpointId`, `FaultId` (adds `none`), `FrameId` (F1–F5), `EmptyString`, `Severity`, `Confidence`, `Visibility`, `InputIssue`, `SafetyKind`.
  - Objects: `InputCheck`, `VisualJudgment`, `Evidence`, `Strength`, `Weakness`, `Improvement`, `SafetyNote`, `NotAssessable`.
- `Evidence` is `{stroke_id, frame_id, metric_key, observation}`.
- `CoachOutputV1` is the lenient parser: enum fields accept any string, so normalise their case in postprocess.
- Also exported: `auditCoachOutputSchema` (from `schema_audit.ts`), `SEVERITY`, `CONFIDENCE`, `SAFETY_KINDS`, `INPUT_ISSUES`, `VISIBILITY`, `NO_FAULT`, `COACH_SCHEMA_VERSION`.

**Stored result (`coach_result_v1.ts`)**
- `CoachResultV1` and its parts: `ResultEvidence`, `ResultHero`, `ResultOverall`, `ResultSubScore`, `ResultCheckpoint`, `ResultStrength`, `ResultWeakness`, `ResultPlanItem`, `ResultDrill`, `ResultStroke`, `ResultSafetyNote`, `ResultMeta`.
- `ResultEvidence` is `{strokeId, tUs, frameId, metricKey, observation, plain, detail: {valueText, targetText}, joints}`.
- `ResultPlanItem.target` is `{metricKey, current, goal}`.
- `hero` is not repeated in `weaknesses`.
- A free result:
  - keeps at most 1 strength;
  - has empty `weaknesses` and `plan`;
  - leaves out `checkpoints`;
  - puts the hidden counts in `locked`.
- Display scores are multiples of 5.

**Rubric (`_shared/rubric/`)**
- `types.ts`: `CheckpointDef`, `FaultDef`, `DrillDef`, `SkillDef`, `MetricSpec`, `RubricBundle`, `SportRubricFile`, `DrillsFile`, `ASSESS_TAGS`, `CHECKPOINT_PHASES`, `ViewFactors`.
- `SkillDef` has `contactOffsetMs`, `views {recommended, allowed}`, `solo` and `rulesTip`; there is no `ruleFlag`.
- `CheckpointDef.plain` is `{vi: PlainTemplates, en: PlainTemplates}` with `PlainTemplates = {low, high, ok}` (no digits). `low`/`high` describe a reading below/above the band (a failed boolean or V item reads `low`); `ok` describes a met target and is the strength template. For one-sided bands, booleans, V and N items `ok` repeats the good side's text.
- `CheckpointDef.safety?: LocalizedText` is the fixed safety note, present exactly when `injuryFlag` is set.
- `schema.ts` holds the Zod copy of these types; `load.ts` has `loadRubric`, `rubricVersion` (async sha256), `canonicalJson` and `allRubricSkills` (a `Map<skillId, sport>`).
- Content: `badminton.json` and `pickleball.json` hold all 12 skills (6 launch, 6 deferred; the live switch is the `enabled_skills` table, seeded in `supabase/seed.sql`), `drills.json` the drills, `glossary.json` the EN↔VI terms (`{id, en, vi, reviewed}`; nothing loads it yet). Thresholds are uncalibrated and the VI copy awaits coach review (M17).

**Metrics (`_shared/engine/metric_catalog.ts`)**
- `METRIC_KEYS` (24), `MetricKey`, `METRIC_CATALOG`, `isMetricKey`, `validateMetricParams`.
- `baseErr` takes `dir: any | forward` (default `any`): `any` is the distance from the ready base; `forward` is signed along the hitting direction (side view only; checkpoints using it set the B view factor to 0).

**Scripts and generated files**
- `scripts/gen-schemas.ts` (with `--check`) writes `shared/schemas/*.json`, including the server-internal `prepared.v1.json` (engine state, from `PreparedAnalysisV1Structure`; the app never decodes it).
- `scripts/gen-minimal-fixture.ts` writes the minimal pose fixture.
- `scripts/_lib/json.ts` has `prettyJson` and `repoPath`.
- Fixtures are in `shared/fixtures/{pose,prepare,results}`. `pose/synthetic_*.json` come from `scripts/gen-synthetic-pose.ts` and `prepare/synthetic_*.json` from `scripts/replay.ts --golden`; `bash scripts/check.sh` runs every generator with `--check`.
- `supabase/tests/contracts/sql_consistency.test.ts` ties the migrations and `seed.sql` to the contracts, the rubric and DESIGN.md (CHECK enums, `enabled_skills`, `plan_limits`, `model_routes`, `app_config`). Change both sides together.

**Rule for the next agents:** each schema `.meta({id})` registers a name in Zod's global registry. Don't reuse these names: `LocalizedText`, `NormRect`, `Pose*`, `StrokePhasesUs`, `PreparedStroke`, `FrameRequest`, `QuotaPreview`, `CleanStroke`, `Result*`, `CatalogSkill`, `CatalogPlan`.

## Engine outputs

Import from `@shared/engine/index.ts`. Everything is pure and deterministic; the handler parses the body with `PoseV1` first.

**`prepare(pose, opts)` / `reprepare(rawPose, {cameraView, excludedStrokeIds, handedness}, opts)`**
- `opts`: `{rubric, skill?, view?, excludedStrokeIds?, handedness?, frameMode?, userId?, rubricVersion?, timings?}`. `skill` defaults to `pose.session.skill`, `frameMode` to `frameModeForPose(pose)`, `view` to the pose's `cameraView` (and to `viewGuess` when that is `auto`).
- Returns `{ok: true, response, prepared, cleanTrack}` or `{ok: false, code, tips, message}`; `code` is a `PrepareRejectionCode` (422) and `tips` its `REJECTION_TIPS`.
- `response` is `PrepareResponseV1` without `quota`; add it with `withQuota(response, quota)`. Pass `userId` so that `cleanTrackPath` is `{uid}/{analysisId}/pose.clean.json`; `cleanTrackPath(uid, id)` is exported too.
- `prepared` is `PreparedAnalysisV1` (store it in `analyses.prepared`). `cleanTrack` is `CleanTrackV1` (store it as `pose.clean.json`).
- Stroke ids depend only on the pose and the handedness, so `excludedStrokeIds` survive view changes. Unknown ids are ignored. Excluding every stroke returns `no_strokes_detected`.
- If the declared racket wrist is missing on more than `PREPARE_GATES.maxWristMissing` of the clip, the result is `low_visibility` (the other arm is never analysed silently).
- Wrong-hand fallback, first prepare only: if the declared hand finds no stroke, the handedness check suggests the other hand and that wrist is visible, segmentation uses the suggested hand. `handednessSuggestion` and the `handedness_mismatch` warning are set, and `prepared.handedness` records the hand actually used. An explicit `handedness` (reprepare, i.e. the user's answer) is never overridden.

**`PreparedAnalysisV1`** (`prepared_state.ts`, schema `prepared.v1`, Zod `PreparedAnalysisV1`):
- Header fields: `algoVersion` (`ALGO_VERSION`, currently `engine-1.1.0`), `rubricVersion` (pass the sha256 from `rubricVersion()`; defaults to the bundle version), `sport`, `skill`, `view` and `viewSource` (`user` or `guess`), `viewGuess`, `handedness`, `handednessSuggestion`, `direction {f, source}`, `analysisHz`, `srcFps`, `frameMode`, `inputQuality` (pose.v1 `quality`), `coverage` (measured-only, see below), `warnings`, `frameRequests`.
- Storage (`private.upsert_prepared_analysis` `p_fields`, see docs/database.md): the whole object goes in `analyses.prepared`; `algoVersion` → `algo_version`, `rubricVersion` → `rubric_version`, `view` → `view_confirmed`, `handedness`, `frameMode` → `frame_mode`, `analysisHz` → `analysis_hz`, `inputQuality` → `quality`, the upload count of `frameRequests` → `frame_count`.
- `strokes[]`: `{id, tStartUs, tContactUs, contactIsEstimate, tEndUs, vPeak, phases {swingStart|null, ready, bsEnd, contact, ftStop, recovery|null}, readyAssessable, quality, role, excluded, strokeScore, metrics {checkpointId → value}}`.
- `checkpointTable[]` (`CheckpointRow`), one row per skill checkpoint in rubric order:
  - Fields: `{id, subscore, assess, weight, phase, metricKey, unit, status, s, c, value, target, tol, reading, valueText, targetText, perStroke[{strokeId, value, s, c, used}], joints, viewFactor, velocityBased, injuryFlag, validStrokes}`.
  - `status` is one of `measured`, `visual` (V, waiting for Claude), `view_excluded`, `no_data` or `not_assessable` (N).
  - `reading` is one of `low`, `high`, `ok`, `false` or `true` (where the aggregate sits). For bands it picks `FaultDef.when` and `plain.low|high|ok`; weakness candidates carry their own resolved side.
  - `valueText` and `targetText` are language-neutral (`"142°"`, `"≥ 150°"`, `"0.45 T"`, `"3/4"`, `"✓"`).
  - `joints` are already mirrored for left-handers.
- `visualToJudge[]`: `{checkpointId, phase, anchors[5], frameIds (F#; empty when pose_only), viewFactor}`. These are the V checkpoints Claude must judge.
- `candidates`: `{weaknesses[{checkpointId, faultId|null, reading, impact, s, c, plain}] (≤ 6), strengths[{checkpointId, rank, s, c, plain}] (≤ 6), injury[{checkpointId, s, c}]}`.
  - Weakness `reading` is the side the checkpoint missed on: `low | high | false` (`weakSide(row)`: booleans → `false`; a median inside a two-sided band → the side most strokes missed on). `faultId` is the fault with that `when`, or null when the rubric has none for that side. `plain` is `plain.low|high` for that side (`false` → `low`).
  - Strength `plain` is `plain.ok`.
  - Injury-flagged rows never enter the two lists; an `injury` hit becomes the fixed `CheckpointDef.safety` note.
  - Built by `buildCandidates(table, skill, faults, checkpoints)` (the fourth argument supplies `plain`; an unknown checkpoint id throws).
- `subScoresPreview[]`: `{key, weight, score|null, coverage, shown}` from measured checkpoints only. `coverage` is the skill-weighted measured coverage (unjudged V items are not in Σw yet).

**After Claude: `composeScores(checkpointTable, visualJudgments, skill)`** (`score.ts`)
- `visualJudgments` is `[{checkpointId, level (−1..4), confidence: low|medium|high}]`, already normalised by postprocess.
- Returns `{checkpoints (rows with V s/c filled, effectiveWeight, visualLevel), subScores[{key, weight, score, displayScore|null, coverage, confidence, shown, vScale}], overall {score|null, displayScore|null, level|null, coverage, partial, capped}}`.
- Rules:
  - V: `s = level/4`; `c` = 0.4 / 0.7 / 1 × view factor.
  - Coverage Σw counts measured rows and `no_data` rows (assessable in this view but lost by tracking, c = 0), and V rows only once judged 0–4. Excluded checkpoints never count: view factor 0, N, and V items judged −1 or not judged (so pose_only falls back to measured rows).
  - The V share of each sub-score is capped at 35 %, so a sub-score with only V items is not scored.
  - A sub-score is shown at coverage ≥ 0.4.
  - Overall coverage < 0.5 → `partial` with no number; < 0.8 → capped at 85.
  - Display values are `round(x/5)·5`; the level comes from the raw (capped) overall, with no hysteresis.
- Helpers: `displayScore`, `levelFor`, `scoreMetric`, `readingOf`, `faultFor`, `weakSide`, `VISUAL_CONFIDENCE`, `SCORE_CONSTANTS`.

**Tools**
- `scripts/replay.ts <pose.json> [--view …] [--exclude 1,2] [--handedness …] [--out dir] [--mock-claude f]` prints the engine state. `HOOK(M6)` in that file marks where the Claude step plugs in.
- `scripts/replay.ts --golden [--check]` writes or checks `shared/fixtures/prepare/<synthetic>.json`.
- `scripts/bench-engine.ts` measures a 30 s 60 Hz clip (budget 300 ms excluding parse).
- `scripts/fit-contact-offsets.ts [--check]` fits offsets from `shared/fixtures/labels/*.csv`; the CSV format is in that folder's README.
