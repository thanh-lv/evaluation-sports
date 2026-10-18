/**
 * Step 2 (DESIGN.md §6.2): left/right label fixes.
 * - Mirrored source (preferredTransform det < 0): every L/R label is swapped exactly once (`applyMirrorSwap`), and
 *   never anywhere else — coordinates stay in display space because key frames are rendered from that display.
 * - Per limb chain (shoulder–elbow–wrist, hip–knee–ankle): Vision occasionally flips a chain's labels for a few
 *   frames. A chain is swapped at sample i when its swapped distance to the previous (already corrected) positions
 *   is < 0.6× the identity distance.
 */
import type { Joint } from '../contracts/common.ts';
import { cloneRawTrack, isPresent, LR_PAIRS } from './signal_util.ts';
import type { JointSeries, RawTrack } from './types.ts';

/** Swapped distance must be below this fraction of the identity distance to swap a chain. */
export const SWAP_RATIO = 0.6;
/** Previous positions older than this are not trusted as a reference (µs). */
export const SWAP_REF_MAX_AGE_US = 250_000;

/** Limb chains checked by the swap fix, as [left joints, right joints]. */
export const LIMB_CHAINS: readonly (readonly [readonly Joint[], readonly Joint[]])[] = [
  [['lSho', 'lElb', 'lWri'], ['rSho', 'rElb', 'rWri']],
  [['lHip', 'lKne', 'lAnk'], ['rHip', 'rKne', 'rAnk']],
];

function swapSample(a: JointSeries, b: JointSeries, i: number): void {
  [a.x[i], b.x[i]] = [b.x[i], a.x[i]];
  [a.y[i], b.y[i]] = [b.y[i], a.y[i]];
  [a.c[i], b.c[i]] = [b.c[i], a.c[i]];
}

/** Swaps all L/R labels of a mirrored source exactly once; a no-op for unmirrored or already-swapped tracks. */
export function applyMirrorSwap(track: RawTrack): RawTrack {
  if (!track.mirrored || track.mirrorSwapApplied) return track;
  const out = cloneRawTrack(track);
  for (const [l, r] of LR_PAIRS) {
    const tmp = out.joints[l];
    out.joints[l] = out.joints[r];
    out.joints[r] = tmp;
  }
  out.mirrorSwapApplied = true;
  return out;
}

/** Result of the limb-chain swap fix. */
export interface SwapFixResult {
  track: RawTrack;
  /** Number of (sample, chain) swaps performed. */
  swaps: number;
}

/** Per-chain identity-vs-swapped distance test against the last good reference positions. */
export function fixLimbSwaps(track: RawTrack): SwapFixResult {
  const out = cloneRawTrack(track);
  const n = out.tUs.length;
  let swaps = 0;
  for (const [left, right] of LIMB_CHAINS) {
    // Last known (corrected) position and its time, per joint of the chain.
    const refL = left.map(() => ({ x: 0, y: 0, t: -Infinity }));
    const refR = right.map(() => ({ x: 0, y: 0, t: -Infinity }));
    for (let i = 0; i < n; i++) {
      const t = out.tUs[i];
      let idDist = 0, swDist = 0, terms = 0;
      for (let k = 0; k < left.length; k++) {
        const sl = out.joints[left[k]];
        const sr = out.joints[right[k]];
        const okRefL = t - refL[k].t <= SWAP_REF_MAX_AGE_US;
        const okRefR = t - refR[k].t <= SWAP_REF_MAX_AGE_US;
        if (!okRefL || !okRefR) continue;
        if (isPresent(sl, i)) {
          const x = sl.x[i] as number, y = sl.y[i] as number;
          idDist += Math.hypot(x - refL[k].x, y - refL[k].y);
          swDist += Math.hypot(x - refR[k].x, y - refR[k].y);
          terms++;
        }
        if (isPresent(sr, i)) {
          const x = sr.x[i] as number, y = sr.y[i] as number;
          idDist += Math.hypot(x - refR[k].x, y - refR[k].y);
          swDist += Math.hypot(x - refL[k].x, y - refL[k].y);
          terms++;
        }
      }
      if (terms > 0 && swDist < SWAP_RATIO * idDist) {
        for (let k = 0; k < left.length; k++) swapSample(out.joints[left[k]], out.joints[right[k]], i);
        swaps++;
      }
      for (let k = 0; k < left.length; k++) {
        const sl = out.joints[left[k]];
        const sr = out.joints[right[k]];
        if (isPresent(sl, i)) refL[k] = { x: sl.x[i] as number, y: sl.y[i] as number, t };
        if (isPresent(sr, i)) refR[k] = { x: sr.x[i] as number, y: sr.y[i] as number, t };
      }
    }
  }
  return { track: out, swaps };
}
