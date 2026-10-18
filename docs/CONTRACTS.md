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
- `CheckpointDef.plain` is `{vi: {low, high}, en: {low, high}}`.
- `schema.ts` holds the Zod copy of these types; `load.ts` has `loadRubric`, `rubricVersion` (async sha256), `canonicalJson` and `allRubricSkills`.
- The rubric JSON files are placeholders, and their IDs are guesses that the rubric agent may change.

**Metrics (`_shared/engine/metric_catalog.ts`)**
- `METRIC_KEYS` (24), `MetricKey`, `METRIC_CATALOG`, `isMetricKey`, `validateMetricParams`.

**Scripts and generated files**
- `scripts/gen-schemas.ts` (with `--check`) writes `shared/schemas/*.json`.
- `scripts/gen-minimal-fixture.ts` writes the minimal pose fixture.
- `scripts/_lib/json.ts` has `prettyJson` and `repoPath`.
- Fixtures are in `shared/fixtures/{pose,prepare,results}`.

**Rule for the next agents:** each schema `.meta({id})` registers a name in Zod's global registry. Don't reuse these names: `LocalizedText`, `NormRect`, `Pose*`, `StrokePhasesUs`, `PreparedStroke`, `FrameRequest`, `QuotaPreview`, `CleanStroke`, `Result*`, `CatalogSkill`, `CatalogPlan`.
