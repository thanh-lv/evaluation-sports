/** Test helpers: run the signal stages in production order on a pose.v1 document or a synthetic fixture. */
import { PoseV1 } from '@shared/contracts/index.ts';
import { hampelFilter } from '@shared/engine/hampel.ts';
import { normalizePose } from '@shared/engine/normalize.ts';
import { resampleTrack } from '@shared/engine/resample.ts';
import { smoothTrack } from '@shared/engine/savgol.ts';
import { applyMirrorSwap, fixLimbSwaps } from '@shared/engine/swapfix.ts';
import type { AnalysisHz, RawTrack, SmoothTrack } from '@shared/engine/types.ts';
import { loadFixture } from '../../_helpers/fixtures.ts';
import type { SynthTruth } from '../../../../scripts/gen-synthetic-pose.ts';

export interface SignalRun {
  pose: PoseV1;
  normalized: RawTrack;
  cleaned: RawTrack;
  swaps: number;
  hampelRemoved: number;
  smooth: SmoothTrack;
}

/** normalize → mirror swap → limb swap fix → Hampel → resample → SG, as prepare.ts will do. */
export function runSignal(input: unknown): SignalRun {
  const pose = PoseV1.parse(input);
  const normalized = normalizePose(pose);
  const swapped = fixLimbSwaps(applyMirrorSwap(normalized));
  const hampel = hampelFilter(swapped.track);
  const grid = resampleTrack(hampel.track, pose.video.analysisHz as AnalysisHz);
  return {
    pose,
    normalized,
    cleaned: hampel.track,
    swaps: swapped.swaps,
    hampelRemoved: hampel.removed,
    smooth: smoothTrack(grid),
  };
}

/** Loads `shared/fixtures/pose/<name>.json` and its `.truth.json` sidecar. */
export async function loadSynthetic(name: string): Promise<{ pose: unknown; truth: SynthTruth }> {
  return {
    pose: await loadFixture(`pose/${name}.json`),
    truth: await loadFixture<SynthTruth>(`pose/${name}.truth.json`),
  };
}

/** Segmentation parameters of the launch skills (DESIGN.md §6.2 step 7 table; contact offsets start at 0). */
export const LAUNCH_SEGMENT_PARAMS: Record<string, { vmin: number; nms: number; contactOffsetMs: number }> = {
  'bd.clear_fh': { vmin: 4, nms: 0.8, contactOffsetMs: 0 },
  'bd.smash': { vmin: 4, nms: 0.8, contactOffsetMs: 0 },
  'bd.serve_low': { vmin: 1.2, nms: 2.0, contactOffsetMs: 0 },
  'pb.serve': { vmin: 2, nms: 2.0, contactOffsetMs: 0 },
  'pb.dink': { vmin: 1.2, nms: 0.8, contactOffsetMs: 0 },
  'pb.drop3': { vmin: 1.5, nms: 1.0, contactOffsetMs: 0 },
};
