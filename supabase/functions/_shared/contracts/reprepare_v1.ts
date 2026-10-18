/**
 * `reprepare.v1`: re-runs prepare on the stored `pose.raw.json` after the "Xác nhận cú đánh" screen
 * (DESIGN.md §7.2). Free; the client always sends the full current choice, not a diff.
 */
import { z } from 'zod';
import { ConfirmedCameraView, Handedness, LowerUuid } from './common.ts';

export const ReprepareV1 = z.object({
  schema: z.literal('reprepare.v1'),
  analysisId: LowerUuid,
  /** Confirmed view (never `auto`); scoring uses it instead of viewGuess. */
  cameraView: ConfirmedCameraView,
  /** Stroke ids from the previous prepare response that the user unticked. */
  excludedStrokeIds: z.array(z.number().int().positive()).max(12),
  handedness: Handedness,
});
export type ReprepareV1 = z.infer<typeof ReprepareV1>;
