/**
 * Step 10 (DESIGN.md §6.2; definitions in DESIGN-v1.0 §6.2 item 7): the metric registry. One evaluator per
 * METRIC_CATALOG key, each returning `{value, conf}` where conf is the mean confidence of the joints used.
 *
 * Geometry runs on the SG-smoothed grid track (frame-height units, y up) and is expressed in T. Phase handling:
 * - instant metrics are read at the phase's grid index; at `ready` they are the median over the ready window (the
 *   ready pose is defined as a median pose), and `contact+0.2` is 0.2 s after the contact estimate;
 * - window metrics (bsLen, ftLen, ftCross, feetStill, hop, moveOnset, headStill) define their own windows and
 *   ignore the checkpoint phase.
 * A missing phase (ready not assessable, recovery past the clip end) or missing joints give `value: null`.
 *
 * Sign conventions: `f` = hitting direction in image x (+1 → right), from direction.ts; `h` = lateral sign (+ =
 * racket side in image x) from lateralSign(view, handedness), additionally flipped for a mirrored source because
 * the clip stays mirrored in display space after the one-time label swap.
 */
import type { ConfirmedCameraView, Handedness, Joint } from '../contracts/common.ts';
import type { CheckpointPhase, MetricParamValue } from '../rubric/types.ts';
import { lateralSign } from './direction.ts';
import { METRIC_CATALOG, type MetricKey } from './metric_catalog.ts';
import { gridIndexAt, gridRange, median, quantile } from './signal_util.ts';
import type { SmoothTrack, StrokePhases } from './types.ts';

/** Anatomical floor for SWmax (shoulder width / T, ≈ biacromial 38 cm / torso 50 cm). See maxWidths(). */
export const SW_FLOOR_T = 0.7;
/** Hip width floor (≈ bi-iliac 28 cm / torso 50 cm). */
export const HW_FLOOR_T = 0.5;
/** Arm length floor: upper arm + forearm ≈ 0.6 m ≈ 1.2 T. */
export const ARM_FLOOR_T = 1.0;

/** Fixed windows and thresholds of the window metrics (seconds / T / T/s). */
export const METRIC_CONSTANTS = {
  contactPlusS: 0.2,
  headFromS: -0.2,
  headToS: 0.1,
  hopSearchS: 1.5,
  hopAfterPrevContactS: 0.4,
  hopMedianHalfS: 0.25,
  hopGroundFrac: 0.3,
  hopMaxOnsetGapS: 0.07,
  hopMinAirS: 0.1,
  hopMaxAirS: 0.4,
  moveOnsetV: 0.8,
  moveOnsetFrames: 3,
  moveOnsetWindowS: 1.0,
  minWindowCoverage: 0.6,
  minStanceT: 0.15,
} as const;

export interface MetricContext {
  track: SmoothTrack;
  handedness: Handedness;
  view: ConfirmedCameraView;
  f: 1 | -1;
  h: 1 | -1;
  /** SWmax: p95 of shoulder width / T, floored at SW_FLOOR_T. */
  swMax: number;
  /** Same for the hip line. */
  hwMax: number;
  /** Larm per arm: p95 of (|sh−el| + |el−wr|) / T, floored at ARM_FLOOR_T. */
  lArm: { racket: number; nonRacket: number };
  /** Every stroke's phases (window metrics look at the previous stroke). */
  strokes: readonly StrokePhases[];
}

export interface MetricValue {
  value: number | boolean | null;
  /** Mean confidence (0..1) of the joint samples used; 0 when the value is null. */
  conf: number;
  /** Event time for `hop` / `moveOnset` (µs on the grid). */
  atUs?: number;
}

type Params = Readonly<Record<string, MetricParamValue>>;
type Pt = { x: number; y: number; c: number };
const NONE: MetricValue = { value: null, conf: 0 };

const DEG = 180 / Math.PI;

/** Builds the per-clip context: clip-level maxima (SWmax, Larm) and the sign conventions. */
export function buildMetricContext(args: {
  track: SmoothTrack;
  handedness: Handedness;
  view: ConfirmedCameraView;
  f: 1 | -1;
  mirrored: boolean;
  strokes: readonly StrokePhases[];
}): MetricContext {
  const { track, handedness, view, f, mirrored, strokes } = args;
  const h = (lateralSign(view, handedness) * (mirrored ? -1 : 1)) as 1 | -1;
  const w = maxWidths(track);
  const arm = (side: 'racket' | 'nonRacket') => {
    const [sh, el, wr] = armJoints(handedness, side);
    const T = track.torsoT;
    const lens: number[] = [];
    for (let i = 0; i < track.tUs.length; i++) {
      const a = pt(track, sh, i), b = pt(track, el, i), c = pt(track, wr, i);
      if (a && b && c) lens.push((dist(a, b) + dist(b, c)) / T);
    }
    const p95 = quantile(lens, 0.95);
    return Math.max(Number.isFinite(p95) ? p95 : 0, ARM_FLOOR_T);
  };
  return {
    track,
    handedness,
    view,
    f,
    h,
    swMax: w.sw,
    hwMax: w.hw,
    lArm: { racket: arm('racket'), nonRacket: arm('nonRacket') },
    strokes,
  };
}

/**
 * p95 of the horizontal shoulder / hip width in T over the clip, floored at an anatomical prior. Without the floor,
 * a side-view clip in which the player never turns has SWmax ≈ its own (small) width, and `turn` / `stanceW` would
 * read as fully turned / very wide.
 */
export function maxWidths(track: SmoothTrack): { sw: number; hw: number } {
  const sw: number[] = [], hw: number[] = [];
  const T = track.torsoT;
  for (let i = 0; i < track.tUs.length; i++) {
    const ls = pt(track, 'lSho', i), rs = pt(track, 'rSho', i);
    if (ls && rs) sw.push(Math.abs(ls.x - rs.x) / T);
    const lh = pt(track, 'lHip', i), rh = pt(track, 'rHip', i);
    if (lh && rh) hw.push(Math.abs(lh.x - rh.x) / T);
  }
  const p = (v: number[], floor: number) => {
    const q = quantile(v, 0.95);
    return Math.max(Number.isFinite(q) ? q : 0, floor);
  };
  return { sw: p(sw, SW_FLOOR_T), hw: p(hw, HW_FLOOR_T) };
}

/** Evaluates one registry metric for one stroke at a checkpoint phase. */
export function evaluateMetric(
  key: MetricKey,
  params: Params | undefined,
  ctx: MetricContext,
  stroke: StrokePhases,
  phase: CheckpointPhase,
): MetricValue {
  const p = withDefaults(key, params);
  const win = WINDOW_METRICS[key as WindowKey];
  if (win) return win(ctx, stroke, p);
  const instant = INSTANT_METRICS[key as InstantKey];
  if (phase === 'ready') {
    const w = stroke.readyWindow;
    if (!w) return NONE;
    const vals: number[] = [], confs: number[] = [];
    for (let i = w.startIndex; i <= w.endIndex; i++) {
      const r = instant(ctx, i, p, stroke);
      if (typeof r.value === 'number') {
        vals.push(r.value);
        confs.push(r.conf);
      }
    }
    // A ready pose needs most of its window; a few frames are not a "median pose".
    if (vals.length < METRIC_CONSTANTS.minWindowCoverage * (w.endIndex - w.startIndex + 1)) return NONE;
    return { value: median(vals), conf: mean(confs) };
  }
  const i = phaseIndex(ctx.track, stroke, phase === 'window' ? 'contact' : phase);
  return i === null ? NONE : instant(ctx, i, p, stroke);
}

/** Grid index of a per-stroke phase instant; null when the phase does not exist for this stroke. */
export function phaseIndex(track: SmoothTrack, s: StrokePhases, phase: Exclude<CheckpointPhase, 'window'>) {
  switch (phase) {
    case 'ready':
      return s.ready.index;
    case 'bsEnd':
      return s.bsEnd.index;
    case 'contact':
      return s.contact.index;
    case 'ftStop':
      return s.ftStop.index;
    case 'recovery':
      return s.recovery ? s.recovery.index : null;
    case 'contact+0.2': {
      const t = s.contact.tUs + METRIC_CONSTANTS.contactPlusS * 1e6;
      return t <= track.tUs[track.tUs.length - 1] ? gridIndexAt(track, t) : null;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Instant metrics

type InstantKey =
  | 'kneeFlex'
  | 'elbowAng'
  | 'trunkLean'
  | 'shinAngle'
  | 'stanceW'
  | 'stagger'
  | 'turn'
  | 'wristH'
  | 'reach'
  | 'elbowRel'
  | 'wristFwd'
  | 'wristLat'
  | 'vWrist'
  | 'vyWrist'
  | 'vRoot'
  | 'wShift'
  | 'baseErr';
type WindowKey = Exclude<MetricKey, InstantKey>;
type Instant = (ctx: MetricContext, i: number, p: Params, s: StrokePhases) => MetricValue;

const INSTANT_METRICS: Record<InstantKey, Instant> = {
  kneeFlex: (ctx, i, p) =>
    perLeg(ctx, i, p.side as string, (hip, knee, ank) => ({
      value: 180 - angleAt(hip, knee, ank),
      conf: mean([hip.c, knee.c, ank.c]),
    })),
  elbowAng: (ctx, i, p) => {
    const [a, b, c] = joints3(ctx, i, armJoints(ctx.handedness, p.arm as ArmSide));
    return a && b && c ? { value: angleAt(a, b, c), conf: mean([a.c, b.c, c.c]) } : NONE;
  },
  trunkLean: (ctx, i) => {
    const neck = pt(ctx.track, 'neck', i), root = pt(ctx.track, 'root', i);
    if (!neck || !root) return NONE;
    const dx = neck.x - root.x, dy = neck.y - root.y;
    // Behind / front: forward lean is along the camera axis, so only the lateral magnitude is visible.
    const lateralOnly = ctx.view === 'behind' || ctx.view === 'front';
    const value = lateralOnly ? Math.abs(Math.atan2(dx, dy)) * DEG : Math.atan2(dx * ctx.f, dy) * DEG;
    return { value, conf: mean([neck.c, root.c]) };
  },
  shinAngle: (ctx, i, p) =>
    perLeg(ctx, i, p.side as string, (_hip, knee, ank) => ({
      value: Math.atan2((knee.x - ank.x) * ctx.f, knee.y - ank.y) * DEG,
      conf: mean([knee.c, ank.c]),
    }), false),
  stanceW: (ctx, i) => {
    const l = pt(ctx.track, 'lAnk', i), r = pt(ctx.track, 'rAnk', i);
    if (!l || !r) return NONE;
    return { value: Math.abs(l.x - r.x) / ctx.track.torsoT / ctx.swMax, conf: mean([l.c, r.c]) };
  },
  stagger: (ctx, i) => {
    const l = pt(ctx.track, 'lAnk', i), r = pt(ctx.track, 'rAnk', i);
    if (!l || !r) return NONE;
    return { value: Math.abs(l.x - r.x) / ctx.track.torsoT, conf: mean([l.c, r.c]) };
  },
  turn: (ctx, i, p) => {
    const hip = p.line === 'hip';
    const a = pt(ctx.track, hip ? 'lHip' : 'lSho', i), b = pt(ctx.track, hip ? 'rHip' : 'rSho', i);
    if (!a || !b) return NONE;
    const r = clamp01(Math.abs(a.x - b.x) / ctx.track.torsoT / (hip ? ctx.hwMax : ctx.swMax));
    // Side view sees the line edge-on when square to the net (0°); behind/front see it full width when square.
    const value = (ctx.view === 'side' ? Math.asin(r) : Math.acos(r)) * DEG;
    return { value, conf: mean([a.c, b.c]) };
  },
  wristH: (ctx, i, p) => {
    const [, , wr] = armJoints(ctx.handedness, p.arm as ArmSide);
    const w = pt(ctx.track, wr, i), root = pt(ctx.track, 'root', i);
    return w && root ? { value: (w.y - root.y) / ctx.track.torsoT, conf: mean([w.c, root.c]) } : NONE;
  },
  reach: (ctx, i, p) => {
    const side = p.arm as ArmSide;
    const [sh, , wr] = armJoints(ctx.handedness, side);
    const w = pt(ctx.track, wr, i), s = pt(ctx.track, sh, i);
    if (!w || !s) return NONE;
    return { value: (w.y - s.y) / ctx.track.torsoT / ctx.lArm[side], conf: mean([w.c, s.c]) };
  },
  elbowRel: (ctx, i, p) => {
    const [sh, el] = armJoints(ctx.handedness, p.arm as ArmSide);
    const e = pt(ctx.track, el, i), s = pt(ctx.track, sh, i);
    return e && s ? { value: (e.y - s.y) / ctx.track.torsoT, conf: mean([e.c, s.c]) } : NONE;
  },
  wristFwd: (ctx, i) => {
    const [sh, , wr] = armJoints(ctx.handedness, 'racket');
    const w = pt(ctx.track, wr, i), s = pt(ctx.track, sh, i);
    return w && s ? { value: ((w.x - s.x) * ctx.f) / ctx.track.torsoT, conf: mean([w.c, s.c]) } : NONE;
  },
  wristLat: (ctx, i) => {
    const [, , wr] = armJoints(ctx.handedness, 'racket');
    const w = pt(ctx.track, wr, i), neck = pt(ctx.track, 'neck', i), root = pt(ctx.track, 'root', i);
    if (!w || !neck || !root) return NONE;
    const mid = (neck.x + root.x) / 2;
    return { value: ((w.x - mid) * ctx.h) / ctx.track.torsoT, conf: mean([w.c, neck.c, root.c]) };
  },
  vWrist: (ctx, i, p, s) => {
    const [, , wr] = armJoints(ctx.handedness, p.arm as ArmSide);
    const speed = ctx.track.vel[wr].speed;
    if (p.stat === 'peak') {
      let best: number | null = null, at = -1;
      for (let k = s.bsEnd.index; k <= s.ftStop.index; k++) {
        const v = speed[k];
        if (v !== null && (best === null || v > best)) {
          best = v;
          at = k;
        }
      }
      return best === null ? NONE : { value: best, conf: ctx.track.joints[wr].c[at] };
    }
    const v = speed[i];
    return v === null ? NONE : { value: v, conf: ctx.track.joints[wr].c[i] };
  },
  vyWrist: (ctx, i, p) => {
    const [, , wr] = armJoints(ctx.handedness, p.arm as ArmSide);
    const v = ctx.track.vel[wr].vy[i];
    return v === null ? NONE : { value: v, conf: ctx.track.joints[wr].c[i] };
  },
  vRoot: (ctx, i) => {
    const v = ctx.track.vel.root.vx[i];
    return v === null ? NONE : { value: Math.abs(v), conf: ctx.track.joints.root.c[i] };
  },
  wShift: (ctx, i) => {
    const l = pt(ctx.track, 'lAnk', i), r = pt(ctx.track, 'rAnk', i), root = pt(ctx.track, 'root', i);
    if (!l || !r || !root) return NONE;
    const [front, rear] = l.x * ctx.f >= r.x * ctx.f ? [l, r] : [r, l];
    // Feet side by side along the hitting axis: the weight-shift ratio is undefined.
    if (Math.abs(front.x - rear.x) / ctx.track.torsoT < METRIC_CONSTANTS.minStanceT) return NONE;
    const value = Math.min(1.5, Math.max(-0.5, (root.x - rear.x) / (front.x - rear.x)));
    return { value, conf: mean([l.c, r.c, root.c]) };
  },
  baseErr: (ctx, i, _p, s) => {
    const root = pt(ctx.track, 'root', i);
    if (!root) return NONE;
    let base: { x: number; y: number; c: number } | null = null;
    let baseScale = 1;
    if (s.readyWindow) {
      const xs: number[] = [], ys: number[] = [], cs: number[] = [];
      for (let k = s.readyWindow.startIndex; k <= s.readyWindow.endIndex; k++) {
        const q = pt(ctx.track, 'root', k);
        if (q) {
          xs.push(q.x);
          ys.push(q.y);
          cs.push(q.c);
        }
      }
      if (xs.length) base = { x: median(xs), y: median(ys), c: mean(cs) };
    }
    if (!base) {
      // No ready window: the fallback ready frame is a weaker base estimate.
      base = pt(ctx.track, 'root', s.ready.index);
      baseScale = 0.5;
    }
    if (!base) return NONE;
    return { value: dist(root, base) / ctx.track.torsoT, conf: mean([root.c, base.c]) * baseScale };
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Window metrics

type WindowFn = (ctx: MetricContext, s: StrokePhases, p: Params) => MetricValue;

const WINDOW_METRICS: Record<WindowKey, WindowFn> = {
  bsLen: (ctx, s) => {
    const start = s.swingStart ?? s.bsEnd;
    const r = pathLength(ctx, start.index, s.contact.index);
    // Without a swingStart only the forward half of the swing is measured: halve the confidence.
    return s.swingStart || r.value === null ? r : { ...r, conf: r.conf * 0.5 };
  },
  ftLen: (ctx, s) => pathLength(ctx, s.contact.index, s.ftStop.index),
  ftCross: (ctx, s, p) => {
    const track = ctx.track;
    const [, , wr] = armJoints(ctx.handedness, 'racket');
    const range = gridRange(track, s.contact.tUs + 1, s.contact.tUs + (p.withinS as number) * 1e6);
    if (!range) return NONE;
    let crossed = false, used = 0;
    const confs: number[] = [];
    for (let i = range[0]; i <= range[1]; i++) {
      const w = pt(track, wr, i), neck = pt(track, 'neck', i), root = pt(track, 'root', i);
      if (!w || !neck || !root || Math.abs(neck.y - root.y) < 1e-6) continue;
      used++;
      confs.push(mean([w.c, neck.c, root.c]));
      const lineX = neck.x + ((root.x - neck.x) * (neck.y - w.y)) / (neck.y - root.y);
      if ((w.x - lineX) * ctx.h < 0) crossed = true;
    }
    if (used < METRIC_CONSTANTS.minWindowCoverage * (range[1] - range[0] + 1)) return NONE;
    return { value: crossed, conf: mean(confs) };
  },
  feetStill: (ctx, s) => {
    let best: number | null = null;
    const confs: number[] = [];
    for (const ank of ['lAnk', 'rAnk'] as const) {
      const a0 = pt(ctx.track, ank, s.ready.index);
      if (!a0) continue;
      let m = 0;
      for (let i = s.ready.index; i <= s.contact.index; i++) {
        const a = pt(ctx.track, ank, i);
        if (!a) continue;
        m = Math.max(m, dist(a, a0));
        confs.push(a.c);
      }
      best = Math.max(best ?? 0, m / ctx.track.torsoT);
    }
    return best === null ? NONE : { value: best, conf: mean(confs) };
  },
  hop: (ctx, s, p) => detectHop(ctx, s, p.minAnkleRiseT as number, p.minRootRiseT as number),
  moveOnset: (ctx, s) => {
    const C = METRIC_CONSTANTS;
    const track = ctx.track;
    const range = gridRange(track, s.contact.tUs + 1, s.contact.tUs + C.moveOnsetWindowS * 1e6);
    if (!range) return NONE;
    const vx = track.vel.root.vx;
    let run = 0, present = 0;
    const confs: number[] = [];
    for (let i = range[0]; i <= range[1]; i++) {
      const v = vx[i];
      if (v === null) {
        run = 0;
        continue;
      }
      present++;
      confs.push(track.joints.root.c[i]);
      run = Math.abs(v) > C.moveOnsetV ? run + 1 : 0;
      if (run >= C.moveOnsetFrames) {
        return { value: true, conf: mean(confs), atUs: track.tUs[i - C.moveOnsetFrames + 1] };
      }
    }
    if (present < C.minWindowCoverage * (range[1] - range[0] + 1)) return NONE;
    return { value: false, conf: mean(confs) };
  },
  headStill: (ctx, s) => {
    const C = METRIC_CONSTANTS;
    const range = gridRange(ctx.track, s.contact.tUs + C.headFromS * 1e6, s.contact.tUs + C.headToS * 1e6);
    if (!range) return NONE;
    let ref: Pt | null = null, m = 0, used = 0;
    const confs: number[] = [];
    for (let i = range[0]; i <= range[1]; i++) {
      const n = pt(ctx.track, 'nose', i);
      if (!n) continue;
      ref ??= n;
      m = Math.max(m, dist(n, ref));
      confs.push(n.c);
      used++;
    }
    if (used < C.minWindowCoverage * (range[1] - range[0] + 1)) return NONE;
    return { value: m / ctx.track.torsoT, conf: mean(confs) };
  },
};

/**
 * Split step (DESIGN.md §6.2 item 10): both ankles rise ≥ minAnkleRiseT above their 0.5 s rolling median and the
 * root rises ≥ minRootRiseT, take-offs ≤ 70 ms apart, landing 0.1–0.4 s after take-off. Take-off / landing are where
 * the rise crosses 30 % of the ankle threshold (the airborne part above the full threshold is too short to time).
 * Searched in [contact − 1.5 s, bsEnd], starting no earlier than 0.4 s after the previous contact.
 */
export function detectHop(ctx: MetricContext, s: StrokePhases, minAnkleRiseT: number, minRootRiseT: number) {
  const C = METRIC_CONSTANTS;
  const track = ctx.track;
  const T = track.torsoT;
  const prev = ctx.strokes.filter((o) => o.contact.tUs < s.contact.tUs).at(-1);
  const startUs = Math.max(
    track.tUs[0],
    s.contact.tUs - C.hopSearchS * 1e6,
    prev ? prev.contact.tUs + C.hopAfterPrevContactS * 1e6 : -Infinity,
  );
  const range = gridRange(track, startUs, s.bsEnd.tUs);
  if (!range) return NONE;
  const [a, b] = range;
  const half = Math.round(C.hopMedianHalfS * track.hz);
  const rise = (j: Joint): (number | null)[] => {
    const y = track.joints[j].y;
    const out: (number | null)[] = [];
    for (let i = a; i <= b; i++) {
      const yi = y[i];
      if (yi === null) {
        out.push(null);
        continue;
      }
      const win: number[] = [];
      for (let k = Math.max(0, i - half); k <= Math.min(y.length - 1, i + half); k++) {
        const v = y[k];
        if (v !== null) win.push(v);
      }
      out.push((yi - median(win)) / T);
    }
    return out;
  };
  const rl = rise('lAnk'), rr = rise('rAnk'), rroot = rise('root');
  const n = b - a + 1;
  const present = rl.filter((v, k) => v !== null && rr[k] !== null).length;
  if (present < C.minWindowCoverage * n) return NONE;
  const confs: number[] = [];
  for (let i = a; i <= b; i++) {
    for (const j of ['lAnk', 'rAnk', 'root'] as const) {
      if (track.joints[j].y[i] !== null) confs.push(track.joints[j].c[i]);
    }
  }
  const conf = mean(confs);
  const ground = C.hopGroundFrac * minAnkleRiseT;
  // Airborne runs of one ankle: [take-off, landing] around each excursion above the threshold.
  const runs = (r: (number | null)[]): [number, number][] => {
    const out: [number, number][] = [];
    for (let k = 0; k < n; k++) {
      if (r[k] === null || (r[k] as number) < minAnkleRiseT) continue;
      let lo = k, hi = k;
      while (lo > 0 && r[lo - 1] !== null && (r[lo - 1] as number) > ground) lo--;
      while (hi < n - 1 && r[hi + 1] !== null && (r[hi + 1] as number) > ground) hi++;
      out.push([lo, hi]);
      k = hi;
    }
    return out;
  };
  const dt = 1 / track.hz;
  for (const [l0, l1] of runs(rl)) {
    for (const [r0, r1] of runs(rr)) {
      if (Math.abs(l0 - r0) * dt > C.hopMaxOnsetGapS) continue;
      const t0 = Math.min(l0, r0), t1 = Math.max(l1, r1);
      const air = (t1 - t0) * dt;
      if (air < C.hopMinAirS || air > C.hopMaxAirS) continue;
      let rootMax = -Infinity;
      for (let k = Math.max(0, t0 - Math.round(C.hopMaxOnsetGapS * track.hz)); k <= t1; k++) {
        const v = rroot[k];
        if (v !== null && v > rootMax) rootMax = v;
      }
      if (rootMax >= minRootRiseT) return { value: true, conf, atUs: track.tUs[a + t0] };
    }
  }
  return { value: false, conf };
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers

type ArmSide = 'racket' | 'nonRacket';

/** [shoulder, elbow, wrist] of the racket or non-racket arm. */
export function armJoints(handedness: Handedness, side: ArmSide): [Joint, Joint, Joint] {
  const p = (side === 'racket') === (handedness === 'right') ? 'r' : 'l';
  return [`${p}Sho`, `${p}Elb`, `${p}Wri`] as [Joint, Joint, Joint];
}

/** Smoothed position and confidence of a joint at grid index i, or null when missing. */
export function pt(track: SmoothTrack, j: Joint, i: number): Pt | null {
  const s = track.joints[j];
  const x = s.x[i], y = s.y[i];
  return x === null || y === null || x === undefined || y === undefined ? null : { x, y, c: s.c[i] };
}

function joints3(ctx: MetricContext, i: number, js: [Joint, Joint, Joint]): [Pt | null, Pt | null, Pt | null] {
  return [pt(ctx.track, js[0], i), pt(ctx.track, js[1], i), pt(ctx.track, js[2], i)];
}

/**
 * Evaluates a per-leg measure on the leg chosen by `side`: lead / rear by hitting direction (front ankle = larger
 * x·f), racket / nonRacket by handedness, left / right, or `both` = mean of the legs present (one leg alone keeps
 * 3/4 of its confidence). `needHip` is false for measures that only use knee and ankle.
 */
function perLeg(
  ctx: MetricContext,
  i: number,
  side: string,
  fn: (hip: Pt, knee: Pt, ank: Pt) => { value: number; conf: number },
  needHip = true,
): MetricValue {
  const leg = (p: 'l' | 'r') => {
    const hip = pt(ctx.track, `${p}Hip` as Joint, i);
    const knee = pt(ctx.track, `${p}Kne` as Joint, i);
    const ank = pt(ctx.track, `${p}Ank` as Joint, i);
    if (!knee || !ank || (needHip && !hip)) return null;
    return fn(hip ?? knee, knee, ank);
  };
  const racketP = ctx.handedness === 'right' ? 'r' : 'l';
  let p: 'l' | 'r' | null = null;
  switch (side) {
    case 'left':
      p = 'l';
      break;
    case 'right':
      p = 'r';
      break;
    case 'racket':
      p = racketP;
      break;
    case 'nonRacket':
      p = racketP === 'r' ? 'l' : 'r';
      break;
    case 'lead':
    case 'rear': {
      const l = pt(ctx.track, 'lAnk', i), r = pt(ctx.track, 'rAnk', i);
      if (!l || !r) return NONE;
      const leftIsFront = l.x * ctx.f >= r.x * ctx.f;
      p = (side === 'lead') === leftIsFront ? 'l' : 'r';
      break;
    }
  }
  if (p) return leg(p) ?? NONE;
  const legs = [leg('l'), leg('r')].filter((x): x is { value: number; conf: number } => x !== null);
  if (legs.length === 0) return NONE;
  if (legs.length === 1) return { value: legs[0].value, conf: legs[0].conf * 0.75 };
  return { value: (legs[0].value + legs[1].value) / 2, conf: (legs[0].conf + legs[1].conf) / 2 };
}

/** Racket-wrist path length (T) over grid indices [a, b]; null when > 40 % of the segments are missing. */
function pathLength(ctx: MetricContext, a: number, b: number): MetricValue {
  const [, , wr] = armJoints(ctx.handedness, 'racket');
  if (b <= a) return { value: 0, conf: pt(ctx.track, wr, a)?.c ?? 0 };
  let len = 0, used = 0;
  const confs: number[] = [];
  let prev = pt(ctx.track, wr, a);
  if (prev) confs.push(prev.c);
  for (let i = a + 1; i <= b; i++) {
    const cur = pt(ctx.track, wr, i);
    if (cur) confs.push(cur.c);
    if (cur && prev) {
      len += dist(cur, prev);
      used++;
    }
    prev = cur;
  }
  if (used < METRIC_CONSTANTS.minWindowCoverage * (b - a)) return NONE;
  // Scale up for the skipped segments so a short dropout does not shorten the path.
  return { value: (len * ((b - a) / used)) / ctx.track.torsoT, conf: mean(confs) };
}

/** Angle at b in degrees for the polyline a–b–c (180° = straight). */
export function angleAt(a: Pt, b: Pt, c: Pt): number {
  const ux = a.x - b.x, uy = a.y - b.y, vx = c.x - b.x, vy = c.y - b.y;
  const nu = Math.hypot(ux, uy), nv = Math.hypot(vx, vy);
  if (nu === 0 || nv === 0) return 180;
  return Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (nu * nv)))) * DEG;
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function mean(v: readonly number[]): number {
  if (v.length === 0) return 0;
  let s = 0;
  for (const x of v) s += x;
  return s / v.length;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Fills catalog defaults for params the rubric left out. */
function withDefaults(key: MetricKey, params: Params | undefined): Params {
  const out: Record<string, MetricParamValue> = {};
  for (const [name, spec] of Object.entries(METRIC_CATALOG[key].params)) out[name] = params?.[name] ?? spec.default;
  return out;
}
