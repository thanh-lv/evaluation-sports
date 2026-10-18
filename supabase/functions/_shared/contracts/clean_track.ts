/**
 * `clean-track.v1`: `pose.clean.json` in Storage `analysis-derived/{uid}/{analysisId}/` (DESIGN.md §6.2 item 14).
 * Read by the iOS skeleton overlay / Premium player and by the Web Lab.
 *
 * Coordinate choice: positions stay in CFS (0..1000, top-left origin, upright display frame) like pose.v1 — but as
 * floats rounded to 0.1 after smoothing — so overlay code is shared between raw and clean tracks and needs only
 * `display` to map to pixels. The engine's internal frame-height/y-up/T units are NOT exported here.
 *
 * Per frame i on the uniform grid `tUs[i] = t0Us + round(i · 1e6 / analysisHz)`:
 * - `kp[i]`     57 numbers in JOINT_ORDER: x, y (float CFS), c (int 0..100). `0,0,0` = missing (gap > 200 ms).
 * - `interp[i]` 19-bit mask; bit j set ⇔ JOINT_ORDER[j] was gap-filled (not observed) at this grid time.
 * L/R labels are already corrected (swap fix and the one-time mirrored swap), so `mirrored` is informational only.
 */
import { z } from 'zod';
import { JOINT_ORDER, KP_PER_FRAME, LowerUuid, MicroSeconds } from './common.ts';
import { StrokeRole } from './prepare_v1.ts';

export const INTERP_MASK_MAX = (1 << JOINT_ORDER.length) - 1;

export const CleanStroke = z.object({
  id: z.number().int().positive(),
  tStartUs: MicroSeconds,
  tContactUs: MicroSeconds,
  contactIsEstimate: z.boolean(),
  tEndUs: MicroSeconds,
  /** All engine phases (µs, snapped to sampled PTS). `recovery`/`swingStart` may be null if out of range. */
  phases: z.object({
    swingStart: MicroSeconds.nullable(),
    ready: MicroSeconds,
    bsEnd: MicroSeconds,
    contact: MicroSeconds,
    ftStop: MicroSeconds,
    recovery: MicroSeconds.nullable(),
  }),
  role: StrokeRole,
  excluded: z.boolean(),
}).meta({ id: 'CleanStroke' });
export type CleanStroke = z.infer<typeof CleanStroke>;

const CleanTrackObject = z.object({
  schema: z.literal('clean-track.v1'),
  analysisId: LowerUuid,
  algoVersion: z.string(),
  analysisHz: z.union([z.literal(30), z.literal(60)]),
  display: z.object({ w: z.number().int().positive(), h: z.number().int().positive() }),
  mirrored: z.boolean(),
  /** Torso unit T as a fraction of frame height (for scale-aware overlays). */
  torsoT: z.number().positive(),
  jointOrder: z.array(z.string()),
  t0Us: MicroSeconds,
  tUs: z.array(MicroSeconds),
  kp: z.array(z.array(z.number())),
  interp: z.array(z.number().int().min(0).max(INTERP_MASK_MAX)),
  strokes: z.array(CleanStroke),
});

export const CleanTrackV1 = CleanTrackObject.superRefine((c, ctx) => {
  if (c.jointOrder.length !== JOINT_ORDER.length || c.jointOrder.some((j, i) => j !== JOINT_ORDER[i])) {
    ctx.addIssue({ code: 'custom', path: ['jointOrder'], message: 'jointOrder must equal JOINT_ORDER' });
  }
  const n = c.tUs.length;
  if (c.kp.length !== n || c.interp.length !== n) {
    ctx.addIssue({ code: 'custom', path: ['kp'], message: 'tUs, kp and interp must have equal length' });
  }
  if (n > 0 && c.tUs[0] !== c.t0Us) ctx.addIssue({ code: 'custom', path: ['t0Us'], message: 't0Us must equal tUs[0]' });
  for (let i = 0; i < n; i++) {
    const expected = c.t0Us + Math.round((i * 1e6) / c.analysisHz);
    if (c.tUs[i] !== expected) {
      ctx.addIssue({ code: 'custom', path: ['tUs', i], message: 'tUs must be the uniform grid' });
      break;
    }
  }
  for (let i = 0; i < c.kp.length; i++) {
    const row = c.kp[i];
    if (row.length !== KP_PER_FRAME || row.some((v, k) => v < 0 || v > (k % 3 === 2 ? 100 : 1000))) {
      ctx.addIssue({ code: 'custom', path: ['kp', i], message: `kp frame must be ${KP_PER_FRAME} values in range` });
      break;
    }
  }
});
export type CleanTrackV1 = z.infer<typeof CleanTrackV1>;
export const CleanTrackV1Structure = CleanTrackObject;

export function isInterpolated(mask: number, jointIndex: number): boolean {
  return (mask & (1 << jointIndex)) !== 0;
}
