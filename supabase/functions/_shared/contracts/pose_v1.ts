/**
 * `pose.v1`: body of `POST /analyze/prepare` (DESIGN-v1.0 §7.1 + DESIGN.md §7.1 v1.1 changes).
 *
 * Track encoding (per frame i):
 * - `tUs[i]`  exact PTS of the exported clip in integer µs, strictly increasing.
 * - `kp[i]`   57 ints = 19 joints × (x, y, c) in JOINT_ORDER; x,y ∈ 0..1000 CFS (top-left, upright display frame),
 *             c ∈ 0..100. `0,0,0` = joint missing (Vision confidence < 0.3 is already sent as missing).
 * - `bbox[i]` target box [x, y, w, h] in CFS 0..1000.
 * - `flags[i]` bitmask: 1 = coasted (tracker predicted), 2 = reacquired.
 *
 * Element-level checks on kp/bbox run in one tight loop inside superRefine (a 1.2 MB payload holds ~110k numbers,
 * and per-element Zod schemas would dominate the 2 s CPU budget).
 */
import { z } from 'zod';
import {
  CameraView,
  CFS_MAX,
  CONF_MAX,
  Handedness,
  JOINT_ORDER,
  KP_PER_FRAME,
  Language,
  Level,
  LowerUuid,
  MicroSeconds,
  type SkillId,
  SkillId as SkillIdSchema,
  Sport,
  sportOfSkill,
  Subject,
} from './common.ts';

export const POSE_V1_MAX_BYTES = 1_200_000;
export const ANALYSIS_HZ = [30, 60] as const;
export const MIN_SEGMENT_MS = 3_000;
export const MAX_SEGMENT_MS = 32_000; // 30 s trim + 1 s padding on each side (DESIGN.md D16)
/** 32 s at 60 Hz plus slack; anything longer is malformed. */
export const MAX_TRACK_FRAMES = 2_048;
export const FLAG_COASTED = 1;
export const FLAG_REACQUIRED = 2;
const MAX_REPORTED_ISSUES = 20;

export const PoseClient = z.object({
  app: z.string(),
  build: z.string(),
  os: z.string(),
  device: z.string(),
  poseApi: z.string(),
  algo: z.string(),
}).meta({ id: 'PoseClient' });

export const PoseSession = z.object({
  sport: Sport,
  skill: SkillIdSchema,
  handedness: Handedness,
  level: Level.nullish(),
  cameraView: CameraView,
  subject: Subject,
  subjectConsent: z.boolean(),
  /** Subject is under 16 → pose-only analysis, no frames uploaded (DESIGN.md D9). */
  subjectMinor: z.boolean(),
  /** Narrative language for Claude (fixed per analysis). */
  language: Language,
}).meta({ id: 'PoseSession' });
export type PoseSession = z.infer<typeof PoseSession>;

export const PoseVideo = z.object({
  source: z.enum(['recorded', 'imported']),
  /** Duration of the exported clip (`source.mov`). */
  durationMs: z.number().int().nonnegative(),
  /** Analyzed range on the exported clip's timeline. */
  segment: z.object({ startMs: z.number().int().nonnegative(), endMs: z.number().int().nonnegative() }),
  srcFps: z.number().positive(),
  analysisHz: z.number().int(),
  /** Composition render size (upright, long edge ≤ 1920). */
  display: z.object({ w: z.number().int().positive(), h: z.number().int().positive() }),
  /** preferredTransform det < 0: the server swaps L/R exactly once. */
  mirrored: z.boolean(),
}).meta({ id: 'PoseVideo' });
export type PoseVideo = z.infer<typeof PoseVideo>;

export const PoseQuality = z.object({
  framesTotal: z.number().int().nonnegative(),
  framesWithTarget: z.number().int().nonnegative(),
  meanLimbConf: z.number().min(0).max(1),
  playerHeightFrac: z.number().min(0).max(1),
  trackResets: z.number().int().nonnegative(),
  ambiguousAtMs: z.array(z.number().int().nonnegative()),
}).meta({ id: 'PoseQuality' });
export type PoseQuality = z.infer<typeof PoseQuality>;

export const PoseTrack = z.object({
  jointOrder: z.array(z.string()),
  tUs: z.array(MicroSeconds).min(2).max(MAX_TRACK_FRAMES),
  kp: z.array(z.array(z.number())),
  bbox: z.array(z.array(z.number())),
  flags: z.array(z.number().int().min(0).max(FLAG_COASTED | FLAG_REACQUIRED)),
}).meta({ id: 'PoseTrack' });
export type PoseTrack = z.infer<typeof PoseTrack>;

const PoseV1Object = z.object({
  schema: z.literal('pose.v1'),
  analysisId: LowerUuid,
  client: PoseClient,
  session: PoseSession,
  video: PoseVideo,
  quality: PoseQuality,
  track: PoseTrack,
});

type PoseV1Shape = z.infer<typeof PoseV1Object>;
type RefineCtx = z.core.$RefinementCtx<PoseV1Shape>;

function checkSession(p: PoseV1Shape, ctx: RefineCtx): void {
  const s = p.session;
  if (s.subject === 'other' && !s.subjectConsent) {
    ctx.addIssue({ code: 'custom', path: ['session', 'subjectConsent'], message: 'subject=other requires consent' });
  }
  if (s.subjectMinor && s.subject !== 'other') {
    ctx.addIssue({ code: 'custom', path: ['session', 'subjectMinor'], message: 'subjectMinor requires subject=other' });
  }
  if (sportOfSkill(s.skill) !== s.sport) {
    ctx.addIssue({ code: 'custom', path: ['session', 'skill'], message: `skill ${s.skill} is not a ${s.sport} skill` });
  }
}

function checkVideo(p: PoseV1Shape, ctx: RefineCtx): void {
  const v = p.video;
  if (!(ANALYSIS_HZ as readonly number[]).includes(v.analysisHz)) {
    ctx.addIssue({ code: 'custom', path: ['video', 'analysisHz'], message: 'analysisHz must be 30 or 60' });
  }
  const segMs = v.segment.endMs - v.segment.startMs;
  if (segMs < MIN_SEGMENT_MS || segMs > MAX_SEGMENT_MS) {
    ctx.addIssue({
      code: 'custom',
      path: ['video', 'segment'],
      message: `segment duration ${segMs} ms outside ${MIN_SEGMENT_MS}..${MAX_SEGMENT_MS}`,
    });
  }
  if (v.segment.endMs > v.durationMs + 50) {
    ctx.addIssue({ code: 'custom', path: ['video', 'segment', 'endMs'], message: 'segment ends after the clip' });
  }
}

function checkTrack(p: PoseV1Shape, ctx: RefineCtx): void {
  const t = p.track;
  if (t.jointOrder.length !== JOINT_ORDER.length || t.jointOrder.some((j, i) => j !== JOINT_ORDER[i])) {
    ctx.addIssue({ code: 'custom', path: ['track', 'jointOrder'], message: 'jointOrder must equal JOINT_ORDER' });
  }
  const n = t.tUs.length;
  for (const key of ['kp', 'bbox', 'flags'] as const) {
    if (t[key].length !== n) {
      ctx.addIssue({
        code: 'custom',
        path: ['track', key],
        message: `${key}.length ${t[key].length} != tUs.length ${n}`,
      });
    }
  }
  let issues = 0;
  const report = (path: (string | number)[], message: string) => {
    if (issues++ < MAX_REPORTED_ISSUES) ctx.addIssue({ code: 'custom', path: ['track', ...path], message });
  };
  for (let i = 1; i < n; i++) {
    if (!(t.tUs[i] > t.tUs[i - 1])) report(['tUs', i], 'tUs must be strictly increasing');
  }
  const spanUs = n > 0 ? t.tUs[n - 1] - t.tUs[0] : 0;
  if (spanUs > MAX_SEGMENT_MS * 1000) report(['tUs'], `track spans ${spanUs} µs (> ${MAX_SEGMENT_MS} ms)`);

  for (let i = 0; i < t.kp.length; i++) {
    const row = t.kp[i];
    if (row.length !== KP_PER_FRAME) {
      report(['kp', i], `kp frame must have ${KP_PER_FRAME} values, got ${row.length}`);
      continue;
    }
    for (let k = 0; k < KP_PER_FRAME; k++) {
      const v = row[k];
      const max = k % 3 === 2 ? CONF_MAX : CFS_MAX;
      if (!Number.isInteger(v) || v < 0 || v > max) report(['kp', i, k], `kp value must be an int in 0..${max}`);
    }
  }
  for (let i = 0; i < t.bbox.length; i++) {
    const b = t.bbox[i];
    if (b.length !== 4 || b.some((v) => !Number.isInteger(v) || v < 0 || v > CFS_MAX)) {
      report(['bbox', i], 'bbox must be [x,y,w,h] ints in 0..1000');
    }
  }
}

/** pose.v1 with every server check of DESIGN.md §7.1 except catalog membership (see validatePoseAgainstCatalog). */
export const PoseV1 = PoseV1Object.superRefine((p, ctx) => {
  checkSession(p, ctx);
  checkVideo(p, ctx);
  checkTrack(p, ctx);
});
export type PoseV1 = z.infer<typeof PoseV1>;

/** Without the refinements; used for JSON Schema export (refinements do not translate). */
export const PoseV1Structure = PoseV1Object;

/** Pose-only when the subject is a minor (DESIGN.md D9); the handler may also force it for other reasons. */
export function frameModeForPose(pose: Pick<PoseV1, 'session'>): 'frames' | 'pose_only' {
  return pose.session.subjectMinor ? 'pose_only' : 'frames';
}

export type CatalogCheck = { ok: true } | { ok: false; code: 'skill_not_available'; message: string };

/**
 * Checks that the skill is enabled and belongs to the session's sport.
 * `enabledSkills` maps every enabled skill id (rubric ∩ `enabled_skills`) to its sport.
 */
export function validatePoseAgainstCatalog(
  pose: Pick<PoseV1, 'session'>,
  enabledSkills: ReadonlyMap<SkillId, Sport>,
): CatalogCheck {
  const { skill, sport } = pose.session;
  const skillSport = enabledSkills.get(skill);
  if (skillSport === undefined) {
    return { ok: false, code: 'skill_not_available', message: `skill ${skill} is not enabled` };
  }
  if (skillSport !== sport) {
    return { ok: false, code: 'skill_not_available', message: `skill ${skill} does not belong to ${sport}` };
  }
  return { ok: true };
}
