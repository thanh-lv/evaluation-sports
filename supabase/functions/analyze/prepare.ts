/**
 * POST /analyze/prepare (DESIGN.md §6.1, §7.1–§7.3). Body: `pose.v1` (≤ 1.2 MB, 20 per hour per user) or
 * `reprepare.v1` (re-runs the engine on the stored `pose.raw.json`). No quota is used.
 *
 * Order: auth → body → rate limit → schema → catalog → ownership pre-check → engine → ownership-guarded upsert
 * (`upsert_prepared_analysis`; false → 409 `analysis_conflict`) → Storage (`pose.raw.json`, `pose.clean.json` in
 * `analysis-derived`, written only after the row is ours) → `prepare.v1` with the quota preview.
 * Engine rejections are stored as `rejected` drafts (the raw pose is kept for a reprepare) and answered with 422 + tips.
 */
import {
  frameModeForPose,
  POSE_V1_MAX_BYTES,
  PoseV1,
  prepareRequestKind,
  type PrepareResponseV1,
  type QuotaPreview,
  REJECTION_TIPS,
  ReprepareV1,
  validatePoseAgainstCatalog,
} from '@shared/contracts/index.ts';
import { prepare, type PreparedAnalysisV1, type PrepareOutcome, reprepare, withQuota } from '@shared/engine/index.ts';
import type { AuthedUser } from '@shared/auth.ts';
import type { Db } from '@shared/db.ts';
import { httpError } from '@shared/errors.ts';
import { describeIssues, json, readJson } from '@shared/http.ts';
import { loadRubric, rubricVersion } from '@shared/rubric/load.ts';
import { BUCKET_DERIVED, poseCleanPath, poseRawPath } from '@shared/storage.ts';
import type { RouteContext } from '@shared/http.ts';
import type { AnalyzeDeps, AnalyzeLimits } from './deps.ts';
import { buildCatalog, type CatalogCache, enabledSkillMap } from './catalog.ts';

const DRAFT_STATUSES = new Set(['prepared', 'rejected']);
const rubricVersions = new Map<string, Promise<string>>();

function rubricVersionOf(sport: 'badminton' | 'pickleball'): Promise<string> {
  let v = rubricVersions.get(sport);
  if (!v) {
    v = rubricVersion(loadRubric(sport));
    rubricVersions.set(sport, v);
  }
  return v;
}

/** Fixed-window per-user limit (`private.rate_limit_hit`); 429 `rate_limited` with Retry-After. */
export async function enforceRateLimit(
  db: Db,
  userId: string,
  bucket: string,
  limit: number,
  now: Date,
): Promise<void> {
  const r = await db.rpc<{ allowed?: boolean; resetAt?: string } | null>('private', 'rate_limit_hit', {
    p_user_id: userId,
    p_bucket: bucket,
    p_limit: limit,
    p_window_s: 3600,
  });
  if (r?.allowed !== false) return;
  const reset = r.resetAt ? Date.parse(r.resetAt) : NaN;
  const retryAfter = Number.isFinite(reset) ? Math.max(1, Math.ceil((reset - now.getTime()) / 1000)) : 3600;
  throw httpError('rate_limited', `at most ${limit} ${bucket} requests per hour`, {
    headers: { 'retry-after': String(retryAfter) },
  });
}

/** QuotaPreview from `private.quota_status` (read-only). */
export async function quotaPreview(db: Db, userId: string): Promise<QuotaPreview> {
  const q = await db.rpc<
    { tier: QuotaPreview['tier']; remaining: number; nextKind: QuotaPreview['nextKind']; resets_at: string | null }
  >(
    'private',
    'quota_status',
    { p_user_id: userId },
  );
  return { tier: q.tier, remaining: q.remaining, nextKind: q.nextKind, resetsAt: q.resets_at ?? null };
}

/** `analyses` columns taken from the engine state (docs/CONTRACTS.md "Storage"). */
export function preparedFields(p: PreparedAnalysisV1): Record<string, unknown> {
  return {
    prepared: p,
    algo_version: p.algoVersion,
    rubric_version: p.rubricVersion,
    view_confirmed: p.view,
    handedness: p.handedness,
    frame_mode: p.frameMode,
    analysis_hz: p.analysisHz,
    quality: p.inputQuality,
    frame_count: p.frameRequests.filter((f) => f.upload).length,
    excluded_strokes: p.strokes.filter((s) => s.excluded).map((s) => s.id),
  };
}

function sessionFields(pose: PoseV1, userId: string): Record<string, unknown> {
  const s = pose.session;
  return {
    sport: s.sport,
    skill: s.skill,
    camera_view: s.cameraView,
    subject: s.subject,
    subject_consent: s.subjectConsent,
    subject_minor: s.subjectMinor,
    frame_mode: frameModeForPose(pose),
    language: s.language,
    handedness: s.handedness,
    excluded_strokes: [],
    analysis_hz: pose.video.analysisHz,
    video_meta: pose.video,
    quality: pose.quality,
    pose_raw_path: poseRawPath(userId, pose.analysisId),
  };
}

async function upsert(db: Db, userId: string, analysisId: string, fields: Record<string, unknown>): Promise<void> {
  const ok = await db.rpc<boolean>('private', 'upsert_prepared_analysis', {
    p_user_id: userId,
    p_analysis_id: analysisId,
    p_fields: fields,
  });
  if (ok !== true) throw httpError('analysis_conflict', 'analysis id belongs to another user or was already submitted');
}

function rejectionError(out: Extract<PrepareOutcome, { ok: false }>) {
  return httpError(out.code, out.message, { tips: out.tips });
}

async function respond(
  deps: AnalyzeDeps,
  user: AuthedUser,
  out: Extract<PrepareOutcome, { ok: true }>,
): Promise<Response> {
  const body: PrepareResponseV1 = withQuota(out.response, await quotaPreview(deps.db, user.userId));
  return json(body);
}

async function preparePose(
  deps: AnalyzeDeps,
  user: AuthedUser,
  body: unknown,
  catalog: CatalogCache,
): Promise<Response> {
  const parsed = PoseV1.safeParse(body);
  if (!parsed.success) throw httpError('invalid_payload', describeIssues(parsed.error.issues));
  const pose = parsed.data;
  const enabled = enabledSkillMap(await catalog.get(() => buildCatalog(deps.db)));
  const check = validatePoseAgainstCatalog(pose, enabled);
  if (!check.ok) throw httpError('skill_not_available', check.message, { tips: REJECTION_TIPS.skill_not_available });

  // Cheap pre-check before the engine runs; the upsert below is the authoritative guard.
  const existing = await deps.db.selectOne<{ user_id: string; status: string }>(
    'public',
    'analyses',
    'user_id, status',
    { id: pose.analysisId },
  );
  if (existing && (existing.user_id !== user.userId || !DRAFT_STATUSES.has(existing.status))) {
    throw httpError('analysis_conflict', 'analysis id belongs to another user or was already submitted');
  }

  const sport = pose.session.sport;
  const out = prepare(pose, {
    rubric: loadRubric(sport),
    userId: user.userId,
    rubricVersion: await rubricVersionOf(sport),
  });
  const base = sessionFields(pose, user.userId);
  if (!out.ok) {
    await upsert(deps.db, user.userId, pose.analysisId, { ...base, status: 'rejected', failure_code: out.code });
    await deps.storage.uploadJson(BUCKET_DERIVED, poseRawPath(user.userId, pose.analysisId), pose);
    throw rejectionError(out);
  }
  await upsert(deps.db, user.userId, pose.analysisId, {
    ...base,
    ...preparedFields(out.prepared),
    status: 'prepared',
    pose_clean_path: poseCleanPath(user.userId, pose.analysisId),
  });
  await deps.storage.uploadJson(BUCKET_DERIVED, poseRawPath(user.userId, pose.analysisId), pose);
  await deps.storage.uploadJson(BUCKET_DERIVED, poseCleanPath(user.userId, pose.analysisId), out.cleanTrack);
  return respond(deps, user, out);
}

interface DraftRow {
  user_id: string;
  status: string;
  frame_mode: 'frames' | 'pose_only';
  pose_raw_path: string | null;
}

async function reprepareStored(
  deps: AnalyzeDeps,
  user: AuthedUser,
  body: unknown,
  catalog: CatalogCache,
): Promise<Response> {
  const parsed = ReprepareV1.safeParse(body);
  if (!parsed.success) throw httpError('invalid_payload', describeIssues(parsed.error.issues));
  const req = parsed.data;
  const row = await deps.db.selectOne<DraftRow>(
    'public',
    'analyses',
    'user_id, status, frame_mode, pose_raw_path',
    { id: req.analysisId },
  );
  if (!row || row.user_id !== user.userId) throw httpError('analysis_not_found');
  if (!DRAFT_STATUSES.has(row.status)) throw httpError('analysis_conflict', `analysis is ${row.status}`);

  const raw = await deps.storage.downloadJson(
    BUCKET_DERIVED,
    row.pose_raw_path ?? poseRawPath(user.userId, req.analysisId),
  );
  if (raw === null) throw httpError('analysis_not_found', 'stored pose has expired; prepare the clip again');
  const pose = PoseV1.parse(raw); // validated when stored; a failure here is a server bug (500)
  const check = validatePoseAgainstCatalog(pose, enabledSkillMap(await catalog.get(() => buildCatalog(deps.db))));
  if (!check.ok) throw httpError('skill_not_available', check.message, { tips: REJECTION_TIPS.skill_not_available });

  const sport = pose.session.sport;
  const out = reprepare(pose, req, {
    rubric: loadRubric(sport),
    userId: user.userId,
    rubricVersion: await rubricVersionOf(sport),
    frameMode: row.frame_mode,
  });
  if (!out.ok) {
    await upsert(deps.db, user.userId, req.analysisId, {
      status: 'rejected',
      failure_code: out.code,
      view_confirmed: req.cameraView,
      handedness: req.handedness,
      excluded_strokes: req.excludedStrokeIds,
    });
    throw rejectionError(out);
  }
  await upsert(deps.db, user.userId, req.analysisId, {
    ...preparedFields(out.prepared),
    status: 'prepared',
    pose_clean_path: poseCleanPath(user.userId, req.analysisId),
  });
  await deps.storage.uploadJson(BUCKET_DERIVED, poseCleanPath(user.userId, req.analysisId), out.cleanTrack);
  return respond(deps, user, out);
}

export async function handlePrepare(
  req: Request,
  _ctx: RouteContext,
  deps: AnalyzeDeps,
  user: AuthedUser,
  limits: AnalyzeLimits,
  catalog: CatalogCache,
): Promise<Response> {
  const body = await readJson(req, { maxBytes: POSE_V1_MAX_BYTES });
  const kind = prepareRequestKind(body);
  if (kind === null) throw httpError('invalid_payload', 'schema must be pose.v1 or reprepare.v1');
  const now = deps.now?.() ?? new Date();
  if (kind === 'pose.v1') {
    await enforceRateLimit(deps.db, user.userId, 'prepare', limits.preparePerHour, now);
    return preparePose(deps, user, body, catalog);
  }
  await enforceRateLimit(deps.db, user.userId, 'reprepare', limits.reprepPerHour, now);
  return reprepareStored(deps, user, body, catalog);
}
