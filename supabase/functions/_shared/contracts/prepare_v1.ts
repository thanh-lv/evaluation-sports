/**
 * `prepare.v1`: 200 response of `POST /analyze/prepare` for both pose.v1 and reprepare.v1 bodies (DESIGN.md §7.3).
 * Rejections are 422 ApiError bodies `{code, tips[]}` (see common.ts); ownership conflicts are 409.
 *
 * Deviation from the DESIGN example: each stroke carries `excluded` so the confirm grid can re-tick a stroke after
 * a reprepare (excluded strokes stay listed but get no role and no frame requests).
 */
import { z } from 'zod';
import {
  AnalysisKind,
  ConfirmedCameraView,
  FrameId,
  FrameMode,
  FramePhase,
  Handedness,
  LOCAL_FRAME_IDS,
  LowerUuid,
  MicroSeconds,
  NormRect,
  Tier,
  UPLOAD_FRAME_IDS,
} from './common.ts';
import type { PoseV1 } from './pose_v1.ts';
import type { ReprepareV1 } from './reprepare_v1.ts';

export const MAX_STROKES = 12;
export const MAX_LONG_EDGE = 768;

export const PREPARE_WARNINGS = [
  'fps_low', // source < 30 fps or analysis at 30 Hz
  'view_low_confidence', // viewGuess confidence < 0.7 → app asks to confirm the view
  'view_mismatch', // confirmed view differs from viewGuess
  'view_not_recommended', // view is allowed but not recommended for this skill
  'skill_mismatch_suspected',
  'few_strokes', // only 1–2 valid strokes
  'player_small', // median player height 25–35 %
  'handedness_mismatch', // see handednessSuggestion
] as const;
export const PrepareWarning = z.enum(PREPARE_WARNINGS);
export type PrepareWarning = z.infer<typeof PrepareWarning>;

export const StrokePhasesUs = z.object({
  ready: MicroSeconds,
  bsEnd: MicroSeconds,
  contact: MicroSeconds,
  ftStop: MicroSeconds,
}).meta({ id: 'StrokePhasesUs' });
export type StrokePhasesUs = z.infer<typeof StrokePhasesUs>;

export const StrokeRole = z.enum(['best', 'worst']).nullable();
export type StrokeRole = z.infer<typeof StrokeRole>;

export const PreparedStroke = z.object({
  id: z.number().int().positive(),
  tStartUs: MicroSeconds,
  tContactUs: MicroSeconds,
  /** Always true in MVP: contact = peak wrist speed + per-skill offset (DESIGN.md D7). */
  contactIsEstimate: z.boolean(),
  tEndUs: MicroSeconds,
  /** Every phase time is snapped to a sampled (non-interpolated) original tUs. */
  phases: StrokePhasesUs,
  quality: z.number().min(0).max(1),
  role: StrokeRole,
  /** Thumbnail time for the confirm grid (= snapped contact). */
  thumbTUs: MicroSeconds,
  excluded: z.boolean(),
}).meta({ id: 'PreparedStroke' });
export type PreparedStroke = z.infer<typeof PreparedStroke>;

export const FrameRequest = z.object({
  frameId: FrameId,
  strokeId: z.number().int().positive(),
  phase: FramePhase,
  /** A sampled PTS from pose.v1 track.tUs; the device renders at ±0.45 frame tolerance. */
  tUs: MicroSeconds,
  /** Normalized crop in display space (top-left origin); all phases of a stroke share one crop. */
  crop: NormRect,
  upload: z.boolean(),
}).meta({ id: 'FrameRequest' });
export type FrameRequest = z.infer<typeof FrameRequest>;

export const QuotaPreview = z.object({
  tier: Tier,
  remaining: z.number().int().nonnegative(),
  nextKind: AnalysisKind,
  /** ISO 8601 with offset (ICT for calendar months); null for the trial (no reset). */
  resetsAt: z.string().nullable(),
}).meta({ id: 'QuotaPreview' });
export type QuotaPreview = z.infer<typeof QuotaPreview>;

const PrepareResponseObject = z.object({
  schema: z.literal('prepare.v1'),
  analysisId: LowerUuid,
  status: z.literal('prepared'),
  frameMode: FrameMode,
  warnings: z.array(PrepareWarning),
  viewGuess: z.object({ view: ConfirmedCameraView, confidence: z.number().min(0).max(1) }),
  handednessSuggestion: Handedness.nullable(),
  strokes: z.array(PreparedStroke).min(1).max(MAX_STROKES),
  frameRequests: z.array(FrameRequest),
  maxLongEdge: z.number().int().positive(),
  /** Storage path in `analysis-derived`: `{uid}/{analysisId}/pose.clean.json`. */
  cleanTrackPath: z.string(),
  quota: QuotaPreview,
});

/** Invariants the engine must uphold; also asserted on every response in tests. */
export const PrepareResponseV1 = PrepareResponseObject.superRefine((r, ctx) => {
  const ids = new Set<number>();
  for (const s of r.strokes) {
    if (ids.has(s.id)) ctx.addIssue({ code: 'custom', path: ['strokes'], message: `duplicate stroke id ${s.id}` });
    ids.add(s.id);
    if (s.excluded && s.role !== null) {
      ctx.addIssue({ code: 'custom', path: ['strokes'], message: `excluded stroke ${s.id} has a role` });
    }
    if (!(s.tStartUs <= s.tContactUs && s.tContactUs <= s.tEndUs)) {
      ctx.addIssue({ code: 'custom', path: ['strokes'], message: `stroke ${s.id} times out of order` });
    }
  }
  const seen = new Set<string>();
  for (const f of r.frameRequests) {
    if (seen.has(f.frameId)) {
      ctx.addIssue({ code: 'custom', path: ['frameRequests'], message: `duplicate frame ${f.frameId}` });
    }
    seen.add(f.frameId);
    if (!ids.has(f.strokeId)) {
      ctx.addIssue({ code: 'custom', path: ['frameRequests'], message: `${f.frameId} references unknown stroke` });
    }
    const isUploadId = (UPLOAD_FRAME_IDS as readonly string[]).includes(f.frameId);
    const isLocalId = (LOCAL_FRAME_IDS as readonly string[]).includes(f.frameId);
    if (isLocalId && f.upload) {
      ctx.addIssue({ code: 'custom', path: ['frameRequests'], message: `${f.frameId} must never be uploaded` });
    }
    if (r.frameMode === 'pose_only' && f.upload) {
      ctx.addIssue({ code: 'custom', path: ['frameRequests'], message: 'pose_only mode uploads no frames' });
    }
    if (r.frameMode === 'frames' && isUploadId && !f.upload) {
      ctx.addIssue({ code: 'custom', path: ['frameRequests'], message: `${f.frameId} must be uploaded` });
    }
    if ((f.frameId === 'F5') !== (f.phase === 'overview')) {
      ctx.addIssue({ code: 'custom', path: ['frameRequests'], message: 'only F5 is the overview frame' });
    }
  }
});
export type PrepareResponseV1 = z.infer<typeof PrepareResponseV1>;
export const PrepareResponseV1Structure = PrepareResponseObject;

/** Number of frames the submit check expects in Storage (DESIGN.md §6.1 submit step 3). */
export function expectedUploadCount(r: Pick<PrepareResponseV1, 'frameRequests'>): number {
  return r.frameRequests.filter((f) => f.upload).length;
}

/** Body of POST /analyze/prepare: dispatch on `schema`. Parse with PoseV1 or ReprepareV1 accordingly. */
export type PrepareRequest = PoseV1 | ReprepareV1;
export function prepareRequestKind(body: unknown): 'pose.v1' | 'reprepare.v1' | null {
  if (typeof body !== 'object' || body === null) return null;
  const schema = (body as { schema?: unknown }).schema;
  return schema === 'pose.v1' || schema === 'reprepare.v1' ? schema : null;
}
