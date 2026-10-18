/**
 * Step 6 (DESIGN.md §6.2): handedness check. The racket wrist produces the fastest peaks; if at least 4 of the top 5
 * wrist-speed peaks (both wrists pooled) belong to the other wrist, the profile's handedness is probably wrong and
 * prepare returns `handednessSuggestion` (the app asks; re-prepare is free).
 */
import type { Handedness } from '../contracts/common.ts';
import { localMaxima } from './signal_util.ts';
import type { HandednessResult, SmoothTrack } from './types.ts';

/** Peaks slower than this (T/s) are body sway, not swings, and are ignored. */
export const HANDEDNESS_MIN_PEAK = 1.5;
/** Per-wrist NMS so one swing contributes one peak (s). */
export const HANDEDNESS_NMS_S = 0.3;
const TOP_K = 5;
const OTHER_NEEDED = 4;

/** The racket-wrist joint for a handedness. */
export function racketWrist(h: Handedness): 'lWri' | 'rWri' {
  return h === 'left' ? 'lWri' : 'rWri';
}

/** The non-racket wrist for a handedness. */
export function offWrist(h: Handedness): 'lWri' | 'rWri' {
  return h === 'left' ? 'rWri' : 'lWri';
}

/** Runs the top-5 wrist-peak vote; `suggestion` is the opposite hand when the vote says so. */
export function checkHandedness(track: SmoothTrack, profile: Handedness): HandednessResult {
  const nmsSamples = Math.round(HANDEDNESS_NMS_S * track.hz);
  const peaks: HandednessResult['peaks'] = [];
  for (const wrist of ['lWri', 'rWri'] as const) {
    const speed = track.vel[wrist].speed;
    const cands = localMaxima(speed)
      .map((index) => ({ wrist, index, speed: speed[index] as number }))
      .filter((p) => p.speed >= HANDEDNESS_MIN_PEAK)
      .sort((a, b) => b.speed - a.speed);
    const kept: typeof cands = [];
    for (const c of cands) if (kept.every((k) => Math.abs(k.index - c.index) > nmsSamples)) kept.push(c);
    peaks.push(...kept);
  }
  peaks.sort((a, b) => b.speed - a.speed);
  const top = peaks.slice(0, TOP_K);
  const other = offWrist(profile);
  const otherCount = top.filter((p) => p.wrist === other).length;
  const suggestion: Handedness | null = otherCount >= OTHER_NEEDED ? (profile === 'right' ? 'left' : 'right') : null;
  return { suggestion, peaks: top };
}
