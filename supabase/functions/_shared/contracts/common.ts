/**
 * Shared vocabulary for every RacketCoach contract (DESIGN.md §7, DESIGN-v1.0 §7).
 *
 * Conventions used across contracts:
 * - Times on the wire are integer microseconds (`…Us`) of the exported clip's asset timeline (DESIGN.md D5).
 * - UUIDs are lowercase canonical strings (DESIGN.md D14, §5.3 `IDs.lower`).
 * - Client → server payloads accept an omitted key OR `null` for optional fields (`.nullish()`), because Swift's
 *   synthesized Codable omits nil keys. Server → client payloads always emit the key, using `null` (`.nullable()`).
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------------------------------------------
// Identifiers

export const LOWER_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Lowercase canonical UUID (any version). Uppercase is rejected so Storage RLS paths always match. */
export const LowerUuid = z.string().regex(LOWER_UUID_RE, 'must be a lowercase canonical uuid');
export type LowerUuid = z.infer<typeof LowerUuid>;

export const SPORTS = ['badminton', 'pickleball'] as const;
export const Sport = z.enum(SPORTS);
export type Sport = z.infer<typeof Sport>;

/** Skill id prefix per sport: `bd.clear_fh`, `pb.serve`. */
export const SPORT_PREFIX: Readonly<Record<Sport, string>> = { badminton: 'bd', pickleball: 'pb' };

/** Shape check only; membership in the rubric / `enabled_skills` is checked by `validatePoseAgainstCatalog`. */
export const SkillId = z.string().regex(/^(bd|pb)\.[a-z0-9_]+$/, 'must look like bd.<skill> or pb.<skill>');
export type SkillId = z.infer<typeof SkillId>;

export function sportOfSkill(skill: string): Sport | null {
  if (skill.startsWith('bd.')) return 'badminton';
  if (skill.startsWith('pb.')) return 'pickleball';
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Profile / session enums

export const HANDEDNESS = ['right', 'left'] as const;
export const Handedness = z.enum(HANDEDNESS);
export type Handedness = z.infer<typeof Handedness>;

/** Player level (profile, optional) and result level label (DESIGN.md §6.4 bands 0–39/40–59/60–79/80–100). */
export const LEVELS = ['beginner', 'improving', 'intermediate', 'advanced'] as const;
export const Level = z.enum(LEVELS);
export type Level = z.infer<typeof Level>;

/** Camera view the user picked; `auto` means "use the server's viewGuess" (DESIGN.md §7.1). */
export const CAMERA_VIEWS = ['side', 'behind', 'front', 'diagonal', 'auto'] as const;
export const CameraView = z.enum(CAMERA_VIEWS);
export type CameraView = z.infer<typeof CameraView>;

/** A concrete (confirmed or guessed) view: never `auto`. */
export const CONFIRMED_CAMERA_VIEWS = ['side', 'behind', 'front', 'diagonal'] as const;
export const ConfirmedCameraView = z.enum(CONFIRMED_CAMERA_VIEWS);
export type ConfirmedCameraView = z.infer<typeof ConfirmedCameraView>;

/** Rubric view codes. Front (`F`) uses the `B` view factors with lateral signs mirrored (DESIGN.md §6.2 item 10). */
export const VIEW_CODES = ['S', 'B', 'D', 'F'] as const;
export type ViewCode = (typeof VIEW_CODES)[number];
/** The three view-factor columns stored per checkpoint/metric. */
export const FACTOR_VIEW_CODES = ['S', 'B', 'D'] as const;
export type FactorViewCode = (typeof FACTOR_VIEW_CODES)[number];

export const CAMERA_VIEW_TO_CODE: Readonly<Record<ConfirmedCameraView, ViewCode>> = {
  side: 'S',
  behind: 'B',
  front: 'F',
  diagonal: 'D',
};
export const VIEW_CODE_TO_CAMERA_VIEW: Readonly<Record<ViewCode, ConfirmedCameraView>> = {
  S: 'side',
  B: 'behind',
  F: 'front',
  D: 'diagonal',
};

/** Which view-factor column applies, and whether lateral signs must be mirrored (front view). */
export function viewFactorColumn(
  view: ConfirmedCameraView | ViewCode,
): { column: FactorViewCode; mirrorLateral: boolean } {
  const code: ViewCode = view.length === 1 ? (view as ViewCode) : CAMERA_VIEW_TO_CODE[view as ConfirmedCameraView];
  if (code === 'F') return { column: 'B', mirrorLateral: true };
  return { column: code, mirrorLateral: false };
}

export const LANGUAGES = ['vi', 'en'] as const;
export const Language = z.enum(LANGUAGES);
export type Language = z.infer<typeof Language>;

export const SUBJECTS = ['self', 'other'] as const;
export const Subject = z.enum(SUBJECTS);
export type Subject = z.infer<typeof Subject>;

export const FRAME_MODES = ['frames', 'pose_only'] as const;
export const FrameMode = z.enum(FRAME_MODES);
export type FrameMode = z.infer<typeof FrameMode>;

export const TIERS = ['free', 'trial', 'premium'] as const;
export const Tier = z.enum(TIERS);
export type Tier = z.infer<typeof Tier>;

/** Model route kind (`model_routes.kind`): basic = Haiku, standard = Sonnet (DESIGN.md §8.1). */
export const ANALYSIS_KINDS = ['basic', 'standard'] as const;
export const AnalysisKind = z.enum(ANALYSIS_KINDS);
export type AnalysisKind = z.infer<typeof AnalysisKind>;

export const ANALYSIS_STATUSES = ['prepared', 'queued', 'processing', 'succeeded', 'rejected', 'failed'] as const;
export const AnalysisStatus = z.enum(ANALYSIS_STATUSES);
export type AnalysisStatus = z.infer<typeof AnalysisStatus>;

/** `analyses.failure_code` values written by runOnce/cron (DESIGN.md §8.3, §6.6). */
export const FAILURE_CODES = [
  'model_refusal',
  'bad_output',
  'upstream_unavailable',
  'bad_request',
  'expired',
  'internal',
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

/** Rejection codes produced by postprocess input_check (DESIGN.md §8.4 step 1); stored in coach-result `rejection`. */
export const RESULT_REJECTION_CODES = ['not_assessable', 'wrong_sport', 'wrong_skill'] as const;
export type ResultRejectionCode = (typeof RESULT_REJECTION_CODES)[number];

// ---------------------------------------------------------------------------------------------------------------
// Pose skeleton

/** The 19 Vision joints in payload order (DESIGN-v1.0 §7.1). Index i ↔ kp[3i..3i+2] and interp bit i. */
export const JOINT_ORDER = [
  'nose',
  'lEye',
  'rEye',
  'lEar',
  'rEar',
  'neck',
  'lSho',
  'rSho',
  'lElb',
  'rElb',
  'lWri',
  'rWri',
  'root',
  'lHip',
  'rHip',
  'lKne',
  'rKne',
  'lAnk',
  'rAnk',
] as const;
export const Joint = z.enum(JOINT_ORDER);
export type Joint = z.infer<typeof Joint>;
export const JOINT_COUNT = 19;
/** x, y, c per joint. */
export const KP_STRIDE = 3;
export const KP_PER_FRAME = JOINT_COUNT * KP_STRIDE; // 57
export const JOINT_INDEX: Readonly<Record<Joint, number>> = Object.fromEntries(
  JOINT_ORDER.map((j, i) => [j, i]),
) as Record<Joint, number>;

/** CFS = "coordinate frame space": integers 0..1000, origin top-left of the upright display frame. */
export const CFS_MAX = 1000;
export const CONF_MAX = 100;

// ---------------------------------------------------------------------------------------------------------------
// Scores, phases, frames

export const SUB_SCORE_KEYS = ['stance', 'footwork', 'swing', 'contact', 'follow', 'recovery'] as const;
export const SubScoreKey = z.enum(SUB_SCORE_KEYS);
export type SubScoreKey = z.infer<typeof SubScoreKey>;

/** Phases that get a key frame (F1–F4 / L1–L4) and appear in prepare-response strokes. */
export const STROKE_PHASES = ['ready', 'bsEnd', 'contact', 'ftStop'] as const;
export const StrokePhase = z.enum(STROKE_PHASES);
export type StrokePhase = z.infer<typeof StrokePhase>;

/** Every phase the engine computes (DESIGN-v1.0 §6.2 item 5). */
export const ENGINE_PHASES = ['swingStart', 'ready', 'bsEnd', 'contact', 'ftStop', 'recovery'] as const;
export const EnginePhase = z.enum(ENGINE_PHASES);
export type EnginePhase = z.infer<typeof EnginePhase>;

/** Phase label of a frame request; `overview` is F5 (2× target box at the best contact). */
export const FRAME_PHASES = [...STROKE_PHASES, 'overview'] as const;
export const FramePhase = z.enum(FRAME_PHASES);
export type FramePhase = z.infer<typeof FramePhase>;

/** F1–F5 are uploaded (best stroke + overview); L1–L4 are worst-stroke frames kept on device (DESIGN.md D9). */
export const UPLOAD_FRAME_IDS = ['F1', 'F2', 'F3', 'F4', 'F5'] as const;
export const LOCAL_FRAME_IDS = ['L1', 'L2', 'L3', 'L4'] as const;
export const FRAME_IDS = [...UPLOAD_FRAME_IDS, ...LOCAL_FRAME_IDS] as const;
export const FrameId = z.enum(FRAME_IDS);
export type FrameId = z.infer<typeof FrameId>;
export const UploadFrameId = z.enum(UPLOAD_FRAME_IDS);
export type UploadFrameId = z.infer<typeof UploadFrameId>;

/** Phase → frame id for the best (F) and worst (L) stroke. */
export const BEST_FRAME_BY_PHASE: Readonly<Record<StrokePhase, UploadFrameId>> = {
  ready: 'F1',
  bsEnd: 'F2',
  contact: 'F3',
  ftStop: 'F4',
};
export const WORST_FRAME_BY_PHASE: Readonly<Record<StrokePhase, (typeof LOCAL_FRAME_IDS)[number]>> = {
  ready: 'L1',
  bsEnd: 'L2',
  contact: 'L3',
  ftStop: 'L4',
};
export const OVERVIEW_FRAME_ID: UploadFrameId = 'F5';

export const LocalizedText = z.object({ vi: z.string(), en: z.string() }).meta({ id: 'LocalizedText' });
export type LocalizedText = z.infer<typeof LocalizedText>;

/** Integer microseconds (asset timeline). JSON numbers are exact up to 2^53 µs (~285 years). */
export const MicroSeconds = z.number().int().nonnegative();

/** Normalized 0..1 rectangle, top-left origin, in display (composition render) space. */
export const NormRect = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().gt(0).max(1),
  h: z.number().gt(0).max(1),
}).meta({ id: 'NormRect' });
export type NormRect = z.infer<typeof NormRect>;

// ---------------------------------------------------------------------------------------------------------------
// HTTP error catalog

export const API_ERROR_STATUS = {
  // DESIGN-v1.0 §7.2 lists invalid_payload in the 422 rejection form: every body/shape failure is 422 (no tips).
  invalid_payload: 422,
  unauthorized: 401,
  quota_exceeded: 402,
  consent_required: 403,
  forbidden: 403,
  analysis_not_found: 404,
  not_found: 404,
  method_not_allowed: 405,
  analysis_conflict: 409,
  linked_to_other_account: 409,
  payload_too_large: 413,
  // prepare rejections (tips[] are String Catalog keys) — no quota is used
  no_strokes_detected: 422,
  player_too_small: 422,
  low_visibility: 422,
  too_few_frames: 422,
  target_lost: 422,
  fps_too_low: 422,
  clip_too_short: 422,
  clip_too_long: 422,
  skill_not_available: 422,
  // submit precondition: expected key frames are not in Storage
  frames_missing: 422,
  in_flight: 429,
  rate_limited: 429,
  // verify-subscription restore transfer: 3 per 30 days per originalTransactionId (DESIGN.md §9.4)
  transfer_rate_limited: 429,
  internal: 500,
  upstream_unavailable: 502,
  busy_try_later: 503,
} as const satisfies Record<string, number>;

export type ApiErrorCode = keyof typeof API_ERROR_STATUS;
export const API_ERROR_CODES = Object.keys(API_ERROR_STATUS) as [ApiErrorCode, ...ApiErrorCode[]];
export const ApiErrorCodeSchema = z.enum(API_ERROR_CODES);

export const PREPARE_REJECTION_CODES = [
  'no_strokes_detected',
  'player_too_small',
  'low_visibility',
  'too_few_frames',
  'target_lost',
  'fps_too_low',
  'clip_too_short',
  'clip_too_long',
  'skill_not_available',
] as const satisfies readonly ApiErrorCode[];
export type PrepareRejectionCode = (typeof PREPARE_REJECTION_CODES)[number];

export function isPrepareRejection(code: string): code is PrepareRejectionCode {
  return (PREPARE_REJECTION_CODES as readonly string[]).includes(code);
}

export function httpStatusFor(code: ApiErrorCode): number {
  return API_ERROR_STATUS[code];
}

/**
 * Recording-tip String Catalog keys. The iOS `Localizable.xcstrings` and the Web Lab must define every key here
 * (vi + en). Servers only ever send keys from this list.
 */
export const TIP_KEYS = [
  'camera.tip.full_body',
  'camera.tip.move_closer',
  'camera.tip.player_height',
  'camera.tip.lighting',
  'camera.tip.steady_camera',
  'camera.tip.one_player',
  'camera.tip.fps_60',
  'camera.tip.repetitions',
  'camera.tip.clip_length',
  'camera.tip.recommended_view',
  'camera.tip.choose_skill',
] as const;
export type TipKey = (typeof TIP_KEYS)[number];
export const TipKeySchema = z.enum(TIP_KEYS);

/** Default tips per rejection; handlers may append more. */
export const REJECTION_TIPS: Readonly<Record<PrepareRejectionCode | ResultRejectionCode, readonly TipKey[]>> = {
  no_strokes_detected: ['camera.tip.repetitions', 'camera.tip.full_body', 'camera.tip.fps_60'],
  player_too_small: ['camera.tip.move_closer', 'camera.tip.player_height'],
  low_visibility: ['camera.tip.lighting', 'camera.tip.full_body', 'camera.tip.steady_camera'],
  too_few_frames: ['camera.tip.clip_length', 'camera.tip.full_body'],
  target_lost: ['camera.tip.one_player', 'camera.tip.full_body'],
  fps_too_low: ['camera.tip.fps_60'],
  clip_too_short: ['camera.tip.clip_length'],
  clip_too_long: ['camera.tip.clip_length'],
  skill_not_available: ['camera.tip.choose_skill'],
  not_assessable: ['camera.tip.full_body', 'camera.tip.lighting', 'camera.tip.recommended_view'],
  wrong_sport: ['camera.tip.choose_skill'],
  wrong_skill: ['camera.tip.choose_skill', 'camera.tip.repetitions'],
};

/**
 * Error body of every non-2xx response: `{code, message?, tips?}`. `quota_exceeded` (402) also carries
 * `{limit, used, resetsAt}` (DESIGN-v1.0 §6.1), so the app can show "Lượt mới vào <ngày>" or the paywall.
 */
export const ApiError = z.object({
  code: ApiErrorCodeSchema,
  message: z.string().optional(),
  tips: z.array(z.string()).optional(),
  limit: z.number().int().nonnegative().optional(),
  used: z.number().int().nonnegative().optional(),
  /** ISO 8601 with offset; null when the period never resets (trial). */
  resetsAt: z.string().nullable().optional(),
});
export type ApiError = z.infer<typeof ApiError>;

export function apiError(
  code: ApiErrorCode,
  message?: string,
  tips?: readonly string[],
  extra?: Pick<ApiError, 'limit' | 'used' | 'resetsAt'>,
): ApiError {
  const body: ApiError = { code };
  if (message !== undefined) body.message = message;
  if (tips !== undefined) body.tips = [...tips];
  if (extra) Object.assign(body, extra);
  return body;
}
