/**
 * Step 14 (DESIGN.md §6.2): `pose.clean.json` (clean-track.v1) from the smoothed grid track, for the overlay
 * player and the Web Lab. Positions go back to float CFS (0..1000, top-left origin, rounded to 0.1); confidences to
 * ints 0..100 (a present joint keeps at least 1 so it is not mistaken for the 0,0,0 "missing" sentinel).
 */
import { CFS_MAX, CONF_MAX, JOINT_ORDER, KP_PER_FRAME } from '../contracts/common.ts';
import type { CleanStroke, CleanTrackV1 } from '../contracts/clean_track.ts';
import type { PreparedStrokeState } from './prepared_state.ts';
import type { SmoothTrack } from './types.ts';

export function exportCleanTrack(args: {
  analysisId: string;
  algoVersion: string;
  track: SmoothTrack;
  display: { w: number; h: number };
  mirrored: boolean;
  strokes: readonly PreparedStrokeState[];
}): CleanTrackV1 {
  const { track } = args;
  const n = track.tUs.length;
  const kp: number[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    const row = new Array<number>(KP_PER_FRAME).fill(0);
    JOINT_ORDER.forEach((j, ji) => {
      const s = track.joints[j];
      const x = s.x[i], y = s.y[i];
      if (x === null || y === null) return;
      row[ji * 3] = cfs((x / track.aspect) * CFS_MAX);
      row[ji * 3 + 1] = cfs((1 - y) * CFS_MAX);
      row[ji * 3 + 2] = Math.min(CONF_MAX, Math.max(1, Math.round(s.c[i] * CONF_MAX)));
    });
    kp[i] = row;
  }
  const strokes: CleanStroke[] = args.strokes.map((s) => ({
    id: s.id,
    tStartUs: s.tStartUs,
    tContactUs: s.tContactUs,
    contactIsEstimate: s.contactIsEstimate,
    tEndUs: s.tEndUs,
    phases: { ...s.phases },
    role: s.role,
    excluded: s.excluded,
  }));
  return {
    schema: 'clean-track.v1',
    analysisId: args.analysisId,
    algoVersion: args.algoVersion,
    analysisHz: track.hz,
    display: { w: args.display.w, h: args.display.h },
    mirrored: args.mirrored,
    torsoT: Math.round(track.torsoT * 1e5) / 1e5,
    jointOrder: [...JOINT_ORDER],
    t0Us: track.t0Us,
    tUs: track.tUs.slice(),
    kp,
    interp: track.interp.slice(),
    strokes,
  };
}

function cfs(v: number): number {
  return Math.round(Math.min(CFS_MAX, Math.max(0, v)) * 10) / 10;
}
