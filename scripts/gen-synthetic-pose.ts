/**
 * Deterministic synthetic pose.v1 generator for the engine's signal stages (DESIGN.md §6.2 steps 1–9, M4a/M4b).
 *
 * A 2D side-view stick figure (lengths in torso units T) plays a sequence of strokes of one launch skill:
 * - overhead (bd.clear_fh, bd.smash): racket drop behind the back, then a whip over the top peaking at 20–30 T/s,
 *   with a sharp forearm reversal at the back-scratch and the off arm pointing up and pulling down;
 * - underarm (pb.serve, pb.drop3, pb.dink, bd.serve_low): back-and-through swings peaking at 3–12 T/s;
 * - ready stance with knee flex and, for rally skills, a split-step hop (ankles +0.15 T, root +0.08 T).
 * Each forward swing is a minimum-jerk sweep whose duration is solved so the racket-wrist peak equals the target.
 * On top: Gaussian position noise, confidence jitter, short dropouts (c = 0), one long dropout, Vision-like spikes,
 * VFR timestamp jitter and dropped frames, 30/60 Hz, and optional mirrored / left-handed variants.
 *
 * Ground truth goes to a sidecar `<name>.truth.json`: per-stroke contact time (= true racket-wrist speed peak, since
 * the launch contactOffsetMs is 0), true peak speed (T/s), spike positions, hitting direction f.
 *
 *   deno run -A --config supabase/functions/deno.json scripts/gen-synthetic-pose.ts [--check]
 */
import { type Handedness, type Joint, JOINT_ORDER, PoseV1 } from '@shared/contracts/index.ts';
import { prettyJson, repoPath } from './_lib/json.ts';

/** The six launch skills (DESIGN.md §2.1). */
export const LAUNCH_SKILLS = ['bd.clear_fh', 'bd.smash', 'bd.serve_low', 'pb.serve', 'pb.dink', 'pb.drop3'] as const;
export type LaunchSkill = (typeof LAUNCH_SKILLS)[number];

/** Generator options; everything except `skill`, `hz` and `seed` has a realistic default. */
export interface SynthOptions {
  skill: LaunchSkill;
  hz: 30 | 60;
  seed: number;
  /** Number of strokes (default per skill). */
  strokes?: number;
  /** Seconds between contacts (default per skill). */
  spacingS?: number;
  /** Racket-wrist peak speed target in T/s (default per skill). */
  peakSpeedTps?: number;
  /** Hand actually used (default right). */
  playsWith?: Handedness;
  /** Handedness written to session.handedness (default = playsWith). */
  declared?: Handedness;
  /** Source mirrored (det < 0): coordinates and labels mirrored, `video.mirrored = true`. */
  mirrored?: boolean;
  /** Timestamp jitter and dropped frames (default true). */
  vfr?: boolean;
  /** Position noise σ in CFS units (default 2.5; wrists ×1.5). 0 disables noise and confidence jitter. */
  noiseCfs?: number;
  /** Short/long joint dropouts (default true). */
  dropouts?: boolean;
  /** Vision-like position spikes away from contacts (default true). */
  spikes?: boolean;
}

/** Ground-truth sidecar. */
export interface SynthTruth {
  schema: 'synthetic-truth.v1';
  skill: LaunchSkill;
  hz: 30 | 60;
  seed: number;
  playsWith: Handedness;
  declared: Handedness;
  mirrored: boolean;
  /** Torso unit in frame-height units used by the model. */
  torsoT: number;
  /** Hitting direction in image space (+1 = toward image-right). */
  f: 1 | -1;
  /** True racket-wrist speed peak per stroke (µs) — the contact truth while contactOffsetMs = 0. */
  contactsUs: number[];
  /** True racket-wrist peak speed per stroke (T/s). */
  peakSpeedsTps: number[];
  /** Injected outliers: joint label as written in the payload, sample index and time. */
  spikes: { joint: Joint; index: number; tUs: number }[];
}

type Family = 'overhead' | 'underarm';

interface SkillModel {
  family: Family;
  strokes: number;
  spacingS: number;
  peak: number;
  hop: boolean;
  /** Rest angles (deg from straight down, + = forward): racket upper arm/forearm, off upper arm/forearm. */
  rest: [number, number, number, number];
  /** Backswing-end angles of the racket arm. */
  back: [number, number];
  /** Follow-through angles of the racket arm (end of the forward sweep). */
  through: [number, number];
  /** Off-arm angles at the backswing end (overhead: pointing up). */
  offBack: [number, number];
  /** Preparation window relative to contact (s). */
  prep: [number, number];
  /** Recovery window relative to contact (s). */
  recover: [number, number];
  lean: number;
}

const MODELS: Record<LaunchSkill, SkillModel> = {
  'bd.clear_fh': {
    family: 'overhead',
    strokes: 4,
    spacingS: 2.4,
    peak: 24,
    hop: true,
    rest: [40, 100, 30, 50],
    back: [175, 340],
    through: [50, 30],
    offBack: [160, 170],
    prep: [-1.0, -0.12],
    recover: [0.45, 1.15],
    lean: 6,
  },
  'bd.smash': {
    family: 'overhead',
    strokes: 4,
    spacingS: 2.5,
    peak: 28,
    hop: true,
    rest: [40, 100, 30, 50],
    back: [180, 345],
    through: [40, 15],
    offBack: [160, 170],
    prep: [-1.0, -0.12],
    recover: [0.45, 1.15],
    lean: 12,
  },
  'bd.serve_low': {
    family: 'underarm',
    strokes: 3,
    spacingS: 3.4,
    peak: 3.5,
    hop: false,
    rest: [40, 80, 25, 40],
    back: [32, 62],
    through: [52, 110],
    offBack: [30, 50],
    prep: [-0.8, -0.2],
    recover: [0.4, 1.1],
    lean: 8,
  },
  'pb.serve': {
    family: 'underarm',
    strokes: 3,
    spacingS: 3.4,
    peak: 12,
    hop: false,
    rest: [20, 40, 25, 40],
    back: [-50, -40],
    through: [110, 140],
    offBack: [35, 55],
    prep: [-0.9, -0.2],
    recover: [0.45, 1.15],
    lean: 10,
  },
  'pb.dink': {
    family: 'underarm',
    strokes: 5,
    spacingS: 1.8,
    peak: 3,
    hop: true,
    rest: [25, 60, 25, 40],
    back: [8, 28],
    through: [45, 95],
    offBack: [27, 43],
    prep: [-0.55, -0.12],
    recover: [0.3, 0.85],
    lean: 14,
  },
  'pb.drop3': {
    family: 'underarm',
    strokes: 3,
    spacingS: 2.6,
    peak: 7,
    hop: true,
    rest: [20, 40, 25, 40],
    back: [-30, -10],
    through: [75, 105],
    offBack: [32, 50],
    prep: [-0.8, -0.15],
    recover: [0.4, 1.1],
    lean: 10,
  },
};

const DISPLAY = { w: 1920, h: 1080 } as const;
const ASPECT = DISPLAY.w / DISPLAY.h;
/** Torso unit in frame-height units: player ≈ 3.4 T ≈ 60 % of frame height. */
export const SYNTH_TORSO_T = 0.18;
const GROUND = 0.08; // frame-height units
const CENTER_X = 0.5 * ASPECT; // frame-height units
const T0_US = 1_000_000; // segment starts after the 1 s export padding
const LEAD_S = 1.6; // first contact
const TAIL_S = 1.4; // after the last contact
const L_UPPER = 0.62;
const L_FORE = 0.58;

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** Minimum-jerk step from 0 to 1 over [a, b]. */
function mj(t: number, a: number, b: number): number {
  if (t <= a) return 0;
  if (t >= b) return 1;
  const u = (t - a) / (b - a);
  return u * u * u * (10 - 15 * u + 6 * u * u);
}

/** sin² bump of height 1 over [a, b]. */
function bump(t: number, a: number, b: number): number {
  if (t <= a || t >= b) return 0;
  const s = Math.sin((Math.PI * (t - a)) / (b - a));
  return s * s;
}

interface Pose2 {
  th1: number;
  th2: number;
  ph1: number;
  ph2: number;
  lean: number;
  crouch: number;
  hopRoot: number;
  hopAnkle: number;
}

/** Body parameters at time τ relative to one stroke's nominal contact, as deltas from rest. */
function strokeDelta(m: SkillModel, tau: number, swingD: number): Pose2 {
  const [r1, r2, o1, o2] = m.rest;
  const prep = mj(tau, m.prep[0], m.prep[1]);
  const swing = mj(tau, -swingD / 2, swingD / 2);
  const rec = mj(tau, m.recover[0], m.recover[1]);
  const th1 = (m.back[0] - r1) * prep + (m.through[0] - m.back[0]) * swing + (r1 - m.through[0]) * rec;
  const th2 = (m.back[1] - r2) * prep + (m.through[1] - m.back[1]) * swing + (r2 - m.through[1]) * rec;
  // Off arm: up during the preparation, pulled down slightly after contact starts.
  const offDown = mj(tau, -0.2, 0.3);
  const ph1 = (m.offBack[0] - o1) * (prep - offDown);
  const ph2 = (m.offBack[1] - o2) * (prep - offDown);
  const lean = m.family === 'overhead' ? -8 * prep + 18 * swing - 10 * rec : 6 * swing - 6 * rec;
  const crouch = m.family === 'overhead' ? -0.3 * mj(tau, -0.3, 0.1) + 0.3 * mj(tau, 0.4, 1.0) : 0;
  const hop = m.hop ? 1 : 0;
  return {
    th1,
    th2,
    ph1,
    ph2,
    lean,
    crouch,
    hopRoot: hop * 0.08 * bump(tau, -0.95, -0.72),
    hopAnkle: hop * 0.15 * bump(tau, -0.93, -0.72),
  };
}

type World = Record<Joint, [number, number]>;

/** Joint positions in T units (x forward, y up, ground at 0) of a right-handed player facing +x. */
function worldPose(m: SkillModel, tS: number, contactsS: readonly number[], swingD: number): World {
  const p: Pose2 = {
    th1: m.rest[0],
    th2: m.rest[1],
    ph1: m.rest[2],
    ph2: m.rest[3],
    lean: m.lean,
    crouch: 0.5,
    hopRoot: 0,
    hopAnkle: 0,
  };
  for (const tc of contactsS) {
    const tau = tS - tc;
    if (tau < -1.6 || tau > 1.6) continue;
    const d = strokeDelta(m, tau, swingD);
    p.th1 += d.th1;
    p.th2 += d.th2;
    p.ph1 += d.ph1;
    p.ph2 += d.ph2;
    p.lean += d.lean;
    p.crouch += d.crouch;
    p.hopRoot += d.hopRoot;
    p.hopAnkle += d.hopAnkle;
  }
  const rad = Math.PI / 180;
  const rx = 0.2 * Math.sin((2 * Math.PI * tS) / 7); // slow footwork drift
  const root: [number, number] = [rx, 1.85 - 0.2 * p.crouch + p.hopRoot];
  const ln = p.lean * rad;
  const rot = (dx: number, dy: number): [number, number] => [
    dx * Math.cos(ln) + dy * Math.sin(ln),
    -dx * Math.sin(ln) + dy * Math.cos(ln),
  ];
  const add = (a: [number, number], b: [number, number]): [number, number] => [a[0] + b[0], a[1] + b[1]];
  const neck = add(root, rot(0, 1));
  const lSho = add(neck, rot(0.06, -0.1));
  const rSho = add(neck, rot(-0.06, -0.1));
  const limb = (base: [number, number], a: number, len: number): [number, number] =>
    add(base, [len * Math.sin(a * rad), -len * Math.cos(a * rad)]);
  const rElb = limb(rSho, p.th1, L_UPPER);
  const rWri = limb(rElb, p.th2, L_FORE);
  const lElb = limb(lSho, p.ph1, L_UPPER);
  const lWri = limb(lElb, p.ph2, L_FORE);
  const lHip = add(root, [0.04, 0]);
  const rHip = add(root, [-0.04, 0]);
  const lAnk: [number, number] = [rx + 0.35, 0.05 + p.hopAnkle];
  const rAnk: [number, number] = [rx - 0.35, 0.05 + p.hopAnkle];
  const knee = (hip: [number, number], ank: [number, number]): [number, number] => [
    (hip[0] + ank[0]) / 2 + 0.08 + 0.2 * p.crouch,
    (hip[1] + ank[1]) / 2,
  ];
  return {
    nose: add(neck, rot(0.22, 0.3)),
    lEye: add(neck, rot(0.18, 0.37)),
    rEye: add(neck, rot(0.16, 0.37)),
    lEar: add(neck, rot(0.01, 0.33)),
    rEar: add(neck, rot(-0.02, 0.33)),
    neck,
    lSho,
    rSho,
    lElb,
    rElb,
    lWri,
    rWri,
    root,
    lHip,
    rHip,
    lKne: knee(lHip, lAnk),
    rKne: knee(rHip, rAnk),
    lAnk,
    rAnk,
  };
}

function wristSpeed(m: SkillModel, tS: number, contactsS: readonly number[], swingD: number): number {
  const h = 2.5e-4;
  const a = worldPose(m, tS - h, contactsS, swingD).rWri;
  const b = worldPose(m, tS + h, contactsS, swingD).rWri;
  return Math.hypot(b[0] - a[0], b[1] - a[1]) / (2 * h);
}

/** Forward-swing duration (s) whose isolated racket-wrist peak equals `target` T/s (bisection; speed ∝ 1/D). */
function solveSwingDuration(m: SkillModel, target: number): number {
  const peakFor = (d: number) => {
    let best = 0;
    for (let t = -0.4; t <= 0.4; t += 0.001) best = Math.max(best, wristSpeed(m, t, [0], d));
    return best;
  };
  let lo = 0.06, hi = 2.0;
  for (let k = 0; k < 40; k++) {
    const mid = 0.5 * (lo + hi);
    if (peakFor(mid) > target) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** Generates one pose.v1 document plus its ground truth. */
export function generateSyntheticPose(opts: SynthOptions): { pose: Record<string, unknown>; truth: SynthTruth } {
  const m = MODELS[opts.skill];
  const nStrokes = opts.strokes ?? m.strokes;
  const spacing = opts.spacingS ?? m.spacingS;
  const target = opts.peakSpeedTps ?? m.peak;
  const playsWith = opts.playsWith ?? 'right';
  const declared = opts.declared ?? playsWith;
  const mirrored = opts.mirrored ?? false;
  const vfr = opts.vfr ?? true;
  const noise = opts.noiseCfs ?? 2.5;
  const dropouts = opts.dropouts ?? true;
  const spikes = opts.spikes ?? true;
  // Independent streams so e.g. turning VFR off keeps the same stroke schedule.
  const randSchedule = rng(opts.seed * 7919 + 1);
  const randTime = rng(opts.seed * 7919 + 2);
  const randNoise = rng(opts.seed * 7919 + 3);
  const randEvents = rng(opts.seed * 7919 + 4);

  const swingD = solveSwingDuration(m, target);
  const contactsS: number[] = [];
  for (let k = 0; k < nStrokes; k++) contactsS.push(LEAD_S + k * spacing + (randSchedule() - 0.5) * 0.3);
  const durationS = contactsS[contactsS.length - 1] + TAIL_S;

  // Truth: the true racket-wrist speed peak near each nominal contact.
  const contactsUs: number[] = [];
  const peakSpeedsTps: number[] = [];
  for (const tc of contactsS) {
    let bestT = tc, bestV = 0;
    for (let t = tc - 0.3; t <= tc + 0.3; t += 2.5e-4) {
      const v = wristSpeed(m, t, contactsS, swingD);
      if (v > bestV) {
        bestV = v;
        bestT = t;
      }
    }
    contactsUs.push(Math.round(T0_US + bestT * 1e6));
    peakSpeedsTps.push(Math.round(bestV * 1000) / 1000);
  }
  const nearContact = (tUs: number, s: number) => contactsUs.some((c) => Math.abs(c - tUs) < s * 1e6);

  // Timestamps: nominal grid with jitter and occasional dropped frames (never within ±0.3 s of a contact).
  const step = 1e6 / opts.hz;
  const tUs: number[] = [];
  for (let i = 0;; i++) {
    const nominal = T0_US + i * step;
    if (nominal > T0_US + durationS * 1e6) break;
    if (vfr && i > 0 && !nearContact(nominal, 0.3) && randTime() < 0.012) {
      i += Math.floor(randTime() * 3); // drop 1–3 frames
      continue;
    }
    const jitter = vfr && i > 0 ? (randTime() - 0.5) * 0.16 * step : 0;
    const t = Math.round(nominal + jitter);
    if (tUs.length === 0 || t > tUs[tUs.length - 1]) tUs.push(t);
  }
  const n = tUs.length;

  // Clean frames in CFS (float), for a right-handed player facing +x.
  const frames: World[] = tUs.map((t) => {
    const w = worldPose(m, (t - T0_US) / 1e6, contactsS, swingD);
    const out = {} as World;
    for (const j of JOINT_ORDER) {
      const X = CENTER_X + w[j][0] * SYNTH_TORSO_T;
      const Y = GROUND + w[j][1] * SYNTH_TORSO_T;
      out[j] = [(X / ASPECT) * 1000, (1 - Y) * 1000];
    }
    return out;
  });

  // Left-handed players and mirrored sources are the image mirror of a right-hander: x → 1000 − x and every L/R
  // label swapped (a mirrored source is then un-swapped by the server; a left-hander stays as-is).
  const flip = mirrored !== (playsWith === 'left');
  if (flip) {
    for (const fr of frames) {
      const copy = { ...fr };
      for (const j of JOINT_ORDER) fr[j] = [1000 - copy[swapLabel(j)][0], copy[swapLabel(j)][1]];
    }
  }

  const kp: number[][] = [];
  const conf: number[][] = [];
  const missing: boolean[][] = [];
  const racketLabel: Joint = (playsWith === 'left') !== mirrored ? 'lWri' : 'rWri';
  for (let i = 0; i < n; i++) {
    conf.push(JOINT_ORDER.map((j) => {
      if (noise === 0) return 90;
      const base = j.endsWith('Wri') ? 72 : j.endsWith('Ear') || j.endsWith('Eye') ? 65 : 85;
      return Math.max(35, Math.min(99, Math.round(base + gauss(randNoise) * 8)));
    }));
    missing.push(JOINT_ORDER.map(() => false));
  }
  if (dropouts) {
    for (let i = 0; i < n; i++) {
      JOINT_ORDER.forEach((j, ji) => {
        const p = j.endsWith('Ear') || j.endsWith('Eye') ? 0.02 : 0.006;
        if (randEvents() >= p) return;
        const len = 1 + Math.floor(randEvents() * 3);
        if (j === racketLabel && nearContact(tUs[i], 0.3)) return;
        for (let k = i; k < Math.min(n, i + len); k++) missing[k][ji] = true;
      });
    }
    // One long (≈ 300 ms) dropout of an ear: must stay null after gap fill.
    const ear = JOINT_ORDER.indexOf('lEar');
    const start = Math.floor(n * 0.35);
    for (let k = start; k < n && tUs[k] - tUs[start] < 300_000; k++) missing[k][ear] = true;
  }
  const spikeList: SynthTruth['spikes'] = [];
  if (spikes) {
    const candidates: Joint[] = ['lElb', 'rElb', 'lWri', 'rWri', 'lKne', 'rAnk'];
    let tries = 0;
    while (spikeList.length < 3 && tries++ < 200) {
      const i = 2 + Math.floor(randEvents() * (n - 4));
      const joint = candidates[Math.floor(randEvents() * candidates.length)];
      if (nearContact(tUs[i], 0.4) || spikeList.some((s) => Math.abs(s.index - i) < 10)) continue;
      const ji = JOINT_ORDER.indexOf(joint);
      if (missing[i][ji]) continue;
      const amp = 60 + randEvents() * 60;
      const ang = randEvents() * 2 * Math.PI;
      frames[i][joint] = [frames[i][joint][0] + amp * Math.cos(ang), frames[i][joint][1] + amp * Math.sin(ang)];
      spikeList.push({ joint, index: i, tUs: tUs[i] });
    }
  }

  const bbox: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    let minX = 1000, minY = 1000, maxX = 0, maxY = 0;
    JOINT_ORDER.forEach((j, ji) => {
      const [fx, fy] = frames[i][j];
      const sx = noise * (j.endsWith('Wri') ? 1.5 : 1);
      const x = clampInt(fx + (noise ? gauss(randNoise) * sx : 0));
      const y = clampInt(fy + (noise ? gauss(randNoise) * sx : 0));
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      if (missing[i][ji]) row.push(0, 0, 0);
      else row.push(x, y, conf[i][ji]);
    });
    kp.push(row);
    const mx = Math.round((0.25 * SYNTH_TORSO_T * 1000) / ASPECT);
    const my = Math.round(0.25 * SYNTH_TORSO_T * 1000);
    const bx = Math.max(0, minX - mx);
    const by = Math.max(0, minY - my);
    bbox.push([bx, by, Math.min(1000, maxX + mx) - bx, Math.min(1000, maxY + my) - by]);
  }

  const flags = new Array<number>(n).fill(0);
  let limbConfSum = 0, limbConfN = 0;
  for (let i = 0; i < n; i++) {
    JOINT_ORDER.forEach((j, ji) => {
      if (/^(l|r)(Sho|Elb|Wri|Hip|Kne|Ank)$/.test(j) && !missing[i][ji]) {
        limbConfSum += conf[i][ji] / 100;
        limbConfN++;
      }
    });
  }

  const segmentMs = Math.round(durationS * 1000) + 34;
  const sport = opts.skill.startsWith('bd.') ? 'badminton' : 'pickleball';
  const f: 1 | -1 = flip ? -1 : 1;
  const pose = {
    schema: 'pose.v1',
    analysisId: uuidFromSeed(opts.seed, opts.skill, opts.hz, flip),
    client: {
      app: '0.0.0',
      build: '0',
      os: 'synthetic',
      device: 'synthetic',
      poseApi: 'synthetic',
      algo: 'gen-synthetic-pose-1',
    },
    session: {
      sport,
      skill: opts.skill,
      handedness: declared,
      level: 'beginner',
      cameraView: 'side',
      subject: 'self',
      subjectConsent: false,
      subjectMinor: false,
      language: 'vi',
    },
    video: {
      source: 'recorded',
      durationMs: 1000 + segmentMs + 1000,
      segment: { startMs: 1000, endMs: 1000 + segmentMs },
      srcFps: opts.hz,
      analysisHz: opts.hz,
      display: { ...DISPLAY },
      mirrored,
    },
    quality: {
      framesTotal: n,
      framesWithTarget: n,
      meanLimbConf: Math.round((limbConfSum / Math.max(1, limbConfN)) * 1000) / 1000,
      playerHeightFrac: 0.6,
      trackResets: 0,
      ambiguousAtMs: [],
    },
    track: { jointOrder: [...JOINT_ORDER], tUs, kp, bbox, flags },
  };
  const truth: SynthTruth = {
    schema: 'synthetic-truth.v1',
    skill: opts.skill,
    hz: opts.hz,
    seed: opts.seed,
    playsWith,
    declared,
    mirrored,
    torsoT: SYNTH_TORSO_T,
    f,
    contactsUs,
    peakSpeedsTps,
    spikes: spikeList,
  };
  return { pose, truth };
}

/** The opposite-side label (lWri ↔ rWri, …); midline joints map to themselves. */
function swapLabel(j: Joint): Joint {
  return /^[lr][A-Z]/.test(j) ? ((j[0] === 'l' ? 'r' : 'l') + j.slice(1)) as Joint : j;
}

function clampInt(v: number): number {
  return Math.max(0, Math.min(1000, Math.round(v)));
}

/** Deterministic lowercase v4-shaped uuid for a fixture. */
function uuidFromSeed(seed: number, skill: string, hz: number, flip: boolean): string {
  const r = rng([...`${seed}|${skill}|${hz}|${flip}`].reduce((a, c) => Math.imul(a ^ c.charCodeAt(0), 16777619), 2166136261));
  const hex = Array.from({ length: 32 }, () => Math.floor(r() * 16).toString(16));
  hex[12] = '4';
  hex[16] = '89ab'[Math.floor(r() * 4)];
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** The fixtures written to shared/fixtures/pose (each < 300 KB). */
export const SYNTHETIC_FIXTURES: { name: string; opts: SynthOptions }[] = [
  { name: 'synthetic_bd_clear_fh_60', opts: { skill: 'bd.clear_fh', hz: 60, seed: 101 } },
  { name: 'synthetic_bd_smash_30', opts: { skill: 'bd.smash', hz: 30, seed: 102 } },
  { name: 'synthetic_bd_serve_low_60', opts: { skill: 'bd.serve_low', hz: 60, seed: 103 } },
  { name: 'synthetic_pb_serve_30', opts: { skill: 'pb.serve', hz: 30, seed: 104 } },
  { name: 'synthetic_pb_dink_60', opts: { skill: 'pb.dink', hz: 60, seed: 105 } },
  { name: 'synthetic_pb_drop3_30', opts: { skill: 'pb.drop3', hz: 30, seed: 106 } },
  { name: 'synthetic_bd_clear_fh_30_mirrored', opts: { skill: 'bd.clear_fh', hz: 30, seed: 107, mirrored: true } },
  { name: 'synthetic_pb_dink_30_left', opts: { skill: 'pb.dink', hz: 30, seed: 108, playsWith: 'left' } },
];

const MAX_FIXTURE_BYTES = 300_000;

async function main(): Promise<number> {
  const check = Deno.args.includes('--check');
  let failed = 0;
  for (const { name, opts } of SYNTHETIC_FIXTURES) {
    const { pose, truth } = generateSyntheticPose(opts);
    PoseV1.parse(pose); // never write an invalid fixture
    for (const [rel, text] of [
      [`shared/fixtures/pose/${name}.json`, prettyJson(pose)],
      [`shared/fixtures/pose/${name}.truth.json`, prettyJson(truth)],
    ] as const) {
      if (text.length > MAX_FIXTURE_BYTES) {
        console.error(`${rel} is ${text.length} bytes (> ${MAX_FIXTURE_BYTES})`);
        failed++;
        continue;
      }
      const path = repoPath(rel);
      if (check) {
        let current = '';
        try {
          current = await Deno.readTextFile(path);
        } catch { /* missing → out of sync */ }
        if (current !== text) {
          console.error(`${rel} is out of sync (run scripts/gen-synthetic-pose.ts)`);
          failed++;
        } else console.log(`in sync    ${rel}`);
      } else {
        await Deno.writeTextFile(path, text);
        console.log(`wrote      ${rel} (${text.length} bytes)`);
      }
    }
  }
  return failed ? 1 : 0;
}

if (import.meta.main) Deno.exit(await main());
