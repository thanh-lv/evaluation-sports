/**
 * Canonical metric registry keys (DESIGN-v1.0 §6.2 item 7, `hop` per DESIGN.md §6.2 item 10).
 * The engine implements one function per key returning `{value, conf}`; the rubric references keys via
 * `CheckpointDef.metric.fn` and passes `params` validated by `validateMetricParams`.
 *
 * Units: T = torso length |neck − root| (≈ 0.5 m); T/s for speeds; deg for angles.
 * Sign conventions: `f` = hitting-direction sign (side view), `h` = handedness/lateral sign (behind view).
 * View factors are the default per-metric reliability; a checkpoint's own `views` take precedence.
 */
import type { FactorViewCode } from '../contracts/common.ts';
import type { CheckpointPhase } from '../rubric/types.ts';

export const METRIC_KEYS = [
  'kneeFlex',
  'elbowAng',
  'trunkLean',
  'shinAngle',
  'stanceW',
  'stagger',
  'turn',
  'wristH',
  'reach',
  'elbowRel',
  'wristFwd',
  'wristLat',
  'vWrist',
  'vyWrist',
  'vRoot',
  'bsLen',
  'ftLen',
  'ftCross',
  'wShift',
  'feetStill',
  'hop',
  'moveOnset',
  'baseErr',
  'headStill',
] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

export type MetricKind = 'number' | 'boolean' | 'event';
export type MetricUnit = 'deg' | 'T' | 'ratio' | 'T/s' | 'bool' | 'event';
export type MetricViewFactors = Readonly<Record<FactorViewCode, 0 | 0.6 | 1>>;

export type MetricParamSpec =
  | { type: 'enum'; values: readonly string[]; default: string; description: string }
  | { type: 'number'; min: number; max: number; default: number; description: string }
  | { type: 'boolean'; default: boolean; description: string };

export interface MetricDef {
  key: MetricKey;
  unit: MetricUnit;
  kind: MetricKind;
  /** Checkpoint phases at which this metric may be evaluated. */
  phases: readonly CheckpointPhase[];
  params: Readonly<Record<string, MetricParamSpec>>;
  views: MetricViewFactors;
  /** Confidence × 0.5 at 30 Hz (DESIGN-v1.0 §6.4). */
  velocityBased: boolean;
  /** Uses a lateral (left/right) sign that the front view mirrors. */
  lateral: boolean;
  definition: string;
}

/** Instantaneous metrics may be read at any per-stroke phase instant. */
const INSTANT: readonly CheckpointPhase[] = ['ready', 'bsEnd', 'contact', 'contact+0.2', 'ftStop', 'recovery'];
const WINDOW: readonly CheckpointPhase[] = ['window'];

const LEG_SIDE: MetricParamSpec = {
  type: 'enum',
  values: ['lead', 'rear', 'racket', 'nonRacket', 'left', 'right', 'both'],
  default: 'both',
  description: 'which leg; lead/rear by hitting direction, racket = racket-hand side; both = mean',
};
const ARM: MetricParamSpec = {
  type: 'enum',
  values: ['racket', 'nonRacket'],
  default: 'racket',
  description: 'which arm',
};

const ALL1: MetricViewFactors = { S: 1, B: 1, D: 1 };
const ALL06: MetricViewFactors = { S: 0.6, B: 0.6, D: 0.6 };

export const METRIC_CATALOG: Readonly<Record<MetricKey, MetricDef>> = {
  kneeFlex: {
    key: 'kneeFlex',
    unit: 'deg',
    kind: 'number',
    phases: INSTANT,
    params: { side: LEG_SIDE },
    views: { S: 1, B: 0.6, D: 0.6 },
    velocityBased: false,
    lateral: false,
    definition: '180° − ∠(hip, knee, ankle); 0° = straight leg',
  },
  elbowAng: {
    key: 'elbowAng',
    unit: 'deg',
    kind: 'number',
    phases: INSTANT,
    params: { arm: ARM },
    views: ALL06,
    velocityBased: false,
    lateral: false,
    definition: '∠(shoulder, elbow, wrist); 180° = straight arm',
  },
  trunkLean: {
    key: 'trunkLean',
    unit: 'deg',
    kind: 'number',
    phases: INSTANT,
    params: {},
    views: { S: 1, B: 0.6, D: 0.6 },
    velocityBased: false,
    lateral: false,
    definition: 'angle of root→neck from vertical, + toward hitting direction f (lateral magnitude in B)',
  },
  shinAngle: {
    key: 'shinAngle',
    unit: 'deg',
    kind: 'number',
    phases: INSTANT,
    params: { side: LEG_SIDE },
    views: { S: 1, B: 0, D: 0.6 },
    velocityBased: false,
    lateral: false,
    definition: 'ankle→knee from vertical, + when the knee is ahead of the ankle',
  },
  stanceW: {
    key: 'stanceW',
    unit: 'ratio',
    kind: 'number',
    phases: INSTANT,
    params: {},
    views: { S: 0, B: 1, D: 0.6 },
    velocityBased: false,
    lateral: false,
    definition: '|ankL.x − ankR.x| / (SWmax·T); SWmax = p95 shoulder width / T',
  },
  stagger: {
    key: 'stagger',
    unit: 'T',
    kind: 'number',
    phases: INSTANT,
    params: {},
    views: { S: 1, B: 0, D: 0.6 },
    velocityBased: false,
    lateral: false,
    definition: 'fore–aft ankle distance / T',
  },
  turn: {
    key: 'turn',
    unit: 'deg',
    kind: 'number',
    phases: INSTANT,
    params: {
      line: { type: 'enum', values: ['shoulder', 'hip'], default: 'shoulder', description: 'shoulder or hip line' },
    },
    views: { S: 0.6, B: 1, D: 0 },
    velocityBased: false,
    lateral: false,
    definition: 'line rotation magnitude: B acos(clamp(SW/SWmax)), S asin(…); ±15–20° error, magnitude only',
  },
  wristH: {
    key: 'wristH',
    unit: 'T',
    kind: 'number',
    phases: INSTANT,
    params: { arm: ARM },
    views: ALL1,
    velocityBased: false,
    lateral: false,
    definition: '(wrist.y − root.y) / T; 0 = hip level, ≈1 = shoulder',
  },
  reach: {
    key: 'reach',
    unit: 'ratio',
    kind: 'number',
    phases: INSTANT,
    params: { arm: ARM },
    views: ALL1,
    velocityBased: false,
    lateral: false,
    definition: '(wrist.y − shoulder.y) / Larm; Larm = p95 (|sh−el| + |el−wr|) / T; 1 = arm straight up',
  },
  elbowRel: {
    key: 'elbowRel',
    unit: 'T',
    kind: 'number',
    phases: INSTANT,
    params: { arm: ARM },
    views: ALL1,
    velocityBased: false,
    lateral: false,
    definition: '(elbow.y − shoulder.y) / T on the chosen arm',
  },
  wristFwd: {
    key: 'wristFwd',
    unit: 'T',
    kind: 'number',
    phases: INSTANT,
    params: {},
    views: { S: 1, B: 0, D: 0.6 },
    velocityBased: false,
    lateral: false,
    definition: '(wrist.x − racket-shoulder.x) · f / T; + = in front of the body',
  },
  wristLat: {
    key: 'wristLat',
    unit: 'T',
    kind: 'number',
    phases: INSTANT,
    params: {},
    views: { S: 0, B: 1, D: 0.6 },
    velocityBased: false,
    lateral: true,
    definition: '(wrist.x − torso-midline.x) · h / T; + = racket side',
  },
  vWrist: {
    key: 'vWrist',
    unit: 'T/s',
    kind: 'number',
    phases: INSTANT,
    params: {
      arm: ARM,
      stat: { type: 'enum', values: ['at', 'peak'], default: 'at', description: 'value at phase or stroke peak' },
    },
    views: ALL1,
    velocityBased: true,
    lateral: false,
    definition: 'wrist speed from the Savitzky–Golay derivative',
  },
  vyWrist: {
    key: 'vyWrist',
    unit: 'T/s',
    kind: 'number',
    phases: INSTANT,
    params: { arm: ARM },
    views: ALL1,
    velocityBased: true,
    lateral: false,
    definition: 'wrist vertical velocity, + = up',
  },
  vRoot: {
    key: 'vRoot',
    unit: 'T/s',
    kind: 'number',
    phases: INSTANT,
    params: {},
    views: ALL1,
    velocityBased: true,
    lateral: false,
    definition: 'horizontal root speed',
  },
  bsLen: {
    key: 'bsLen',
    unit: 'T',
    kind: 'number',
    phases: WINDOW,
    params: {},
    views: { S: 1, B: 0.6, D: 0.6 },
    velocityBased: false,
    lateral: false,
    definition: 'racket-wrist path length swingStart → contact',
  },
  ftLen: {
    key: 'ftLen',
    unit: 'T',
    kind: 'number',
    phases: WINDOW,
    params: {},
    views: { S: 1, B: 0.6, D: 0.6 },
    velocityBased: false,
    lateral: false,
    definition: 'racket-wrist path length contact → ftStop',
  },
  ftCross: {
    key: 'ftCross',
    unit: 'bool',
    kind: 'boolean',
    phases: WINDOW,
    params: {
      withinS: { type: 'number', min: 0.1, max: 1.5, default: 0.6, description: 'seconds after contact' },
    },
    views: { S: 0, B: 1, D: 0.6 },
    velocityBased: false,
    lateral: true,
    definition: 'racket wrist crosses the neck–root line to the non-racket side within withinS after contact',
  },
  wShift: {
    key: 'wShift',
    unit: 'ratio',
    kind: 'number',
    phases: INSTANT,
    params: {},
    views: { S: 1, B: 0, D: 0.6 },
    velocityBased: false,
    lateral: false,
    definition: '(root.x − rearAnk.x) / (frontAnk.x − rearAnk.x); 0 = rear foot, 1 = front foot',
  },
  feetStill: {
    key: 'feetStill',
    unit: 'T',
    kind: 'number',
    phases: WINDOW,
    params: {},
    views: ALL1,
    velocityBased: false,
    lateral: false,
    definition: 'max ankle displacement from setup (ready) to contact / T',
  },
  hop: {
    key: 'hop',
    unit: 'event',
    kind: 'event',
    phases: WINDOW,
    params: {
      minAnkleRiseT: { type: 'number', min: 0.02, max: 0.5, default: 0.1, description: 'ankle rise above median' },
      minRootRiseT: { type: 'number', min: 0, max: 0.3, default: 0.05, description: 'root rise' },
    },
    views: ALL06,
    velocityBased: true,
    lateral: false,
    definition:
      'split step: both ankles rise ≥ 0.1 T above their 0.5 s rolling median and root rises ≥ 0.05 T, onsets ≤ 70 ms apart, landing 0.1–0.4 s later',
  },
  moveOnset: {
    key: 'moveOnset',
    unit: 'event',
    kind: 'event',
    phases: WINDOW,
    params: {},
    views: ALL06,
    velocityBased: true,
    lateral: false,
    definition: 'horizontal vRoot > 0.8 T/s for ≥ 3 frames',
  },
  baseErr: {
    key: 'baseErr',
    unit: 'T',
    kind: 'number',
    phases: ['recovery', 'ftStop'],
    params: {},
    views: { S: 0.6, B: 1, D: 0.6 },
    velocityBased: false,
    lateral: false,
    definition: '|root − base| / T; base = median root in ready frames',
  },
  headStill: {
    key: 'headStill',
    unit: 'T',
    kind: 'number',
    phases: WINDOW,
    params: {},
    views: ALL1,
    velocityBased: false,
    lateral: false,
    definition: 'nose displacement / T over [−0.2, +0.1] s around contact',
  },
};

export function isMetricKey(key: string): key is MetricKey {
  return Object.hasOwn(METRIC_CATALOG, key);
}

/** Returns human-readable problems with a rubric's `metric.params` for `key` (empty = valid). */
export function validateMetricParams(key: string, params: Record<string, unknown> | undefined): string[] {
  if (!isMetricKey(key)) return [`unknown metric ${key}`];
  const spec = METRIC_CATALOG[key].params;
  const errors: string[] = [];
  for (const [name, value] of Object.entries(params ?? {})) {
    const p = spec[name];
    if (!p) {
      errors.push(`${key}: unknown param ${name}`);
      continue;
    }
    if (p.type === 'enum' && !(typeof value === 'string' && p.values.includes(value))) {
      errors.push(`${key}.${name}: expected one of ${p.values.join('|')}`);
    } else if (p.type === 'number' && !(typeof value === 'number' && value >= p.min && value <= p.max)) {
      errors.push(`${key}.${name}: expected number in ${p.min}..${p.max}`);
    } else if (p.type === 'boolean' && typeof value !== 'boolean') {
      errors.push(`${key}.${name}: expected boolean`);
    }
  }
  return errors;
}
