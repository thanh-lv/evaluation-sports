/**
 * Golden values for every metric of the registry on hand-built tracks (DESIGN-v1.0 §6.2 item 7, DESIGN.md §6.2
 * item 10). Geometry is analytic, so expected values are closed-form.
 */
import { assert, assertAlmostEquals, assertEquals } from '@std/assert';
import type { ConfirmedCameraView, Handedness } from '@shared/contracts/index.ts';
import { METRIC_KEYS, type MetricKey } from '@shared/engine/metric_catalog.ts';
import { buildMetricContext, evaluateMetric, type MetricContext } from '@shared/engine/metrics.ts';
import type { CheckpointPhase, MetricParamValue } from '@shared/rubric/types.ts';
import type { SmoothTrack, StrokePhases } from '@shared/engine/types.ts';
import { type Frame, phasesAt, polar, standing, trackFrom, type XY } from './_track.ts';

const EPS = 1e-6;
const STD_PHASES = { ready: 1, bsEnd: 1.8, contact: 2, ftStop: 2.3, recovery: 3, swingStart: 1.5 };

function setup(
  frame: (t: number) => Frame,
  o: {
    view?: ConfirmedCameraView;
    f?: 1 | -1;
    handedness?: Handedness;
    mirrored?: boolean;
    phases?: Parameters<typeof phasesAt>[1];
    hz?: 30 | 60;
  } = {},
): { ctx: MetricContext; track: SmoothTrack; p: StrokePhases } {
  const track = trackFrom(frame, { hz: o.hz, mirrored: o.mirrored });
  const p = phasesAt(track, o.phases ?? STD_PHASES);
  const ctx = buildMetricContext({
    track,
    handedness: o.handedness ?? 'right',
    view: o.view ?? 'side',
    f: o.f ?? 1,
    mirrored: o.mirrored ?? false,
    strokes: [p],
  });
  return { ctx, track, p };
}

function val(
  s: { ctx: MetricContext; p: StrokePhases },
  key: MetricKey,
  params: Record<string, MetricParamValue> = {},
  phase: CheckpointPhase = 'contact',
) {
  return evaluateMetric(key, params, s.ctx, s.p, phase);
}

function num(r: { value: number | boolean | null }): number {
  assert(typeof r.value === 'number', `expected a number, got ${r.value}`);
  return r.value;
}

/** Leg with knee K: knee flex θ1 + θ2 (thigh θ1 from up, shin θ2 from down, both toward +x). */
function leg(k: XY, t1: number, t2: number): { hip: XY; knee: XY; ank: XY } {
  return { hip: polar(k, 0.2, t1), knee: k, ank: polar(k, 0.2, 180 - t2) };
}

Deno.test('every METRIC_CATALOG key is implemented and returns {value, conf} on a standing figure', () => {
  const s = setup(() => standing());
  for (const key of METRIC_KEYS) {
    const r = val(s, key);
    assert(r.value !== null, `${key} returned null`);
    assert(r.conf > 0 && r.conf <= 1, `${key} conf ${r.conf}`);
  }
});

Deno.test('kneeFlex: 180° − knee angle per leg; lead/rear by hitting direction, racket by handedness', () => {
  const L = leg([1.25, 0.3], 20, 20); // 40°, the front leg (larger x)
  const R = leg([0.8, 0.3], 5, 5); // 10°
  const frame = () => standing({ lHip: L.hip, lKne: L.knee, lAnk: L.ank, rHip: R.hip, rKne: R.knee, rAnk: R.ank });
  const s = setup(frame);
  assertAlmostEquals(num(val(s, 'kneeFlex', { side: 'left' })), 40, EPS);
  assertAlmostEquals(num(val(s, 'kneeFlex', { side: 'right' })), 10, EPS);
  assertAlmostEquals(num(val(s, 'kneeFlex', { side: 'both' })), 25, EPS);
  assertAlmostEquals(num(val(s, 'kneeFlex', { side: 'lead' })), 40, EPS);
  assertAlmostEquals(num(val(s, 'kneeFlex', { side: 'rear' })), 10, EPS);
  assertAlmostEquals(num(val(s, 'kneeFlex', { side: 'racket' })), 10, EPS);
  assertAlmostEquals(num(val(s, 'kneeFlex', { side: 'nonRacket' })), 40, EPS);
  assertAlmostEquals(num(val(s, 'kneeFlex')), 25, EPS, 'default side = both');
  assertAlmostEquals(val(s, 'kneeFlex').conf, 0.9, EPS);
  const back = setup(frame, { f: -1 });
  assertAlmostEquals(num(val(back, 'kneeFlex', { side: 'lead' })), 10, EPS);
  const lefty = setup(frame, { handedness: 'left' });
  assertAlmostEquals(num(val(lefty, 'kneeFlex', { side: 'racket' })), 40, EPS);
  // One leg missing: the other alone, with 3/4 of its confidence.
  const one = setup(() => ({ ...frame(), rKne: undefined }));
  assertAlmostEquals(num(val(one, 'kneeFlex')), 40, EPS);
  assertAlmostEquals(val(one, 'kneeFlex').conf, 0.675, EPS);
});

Deno.test('shinAngle: ankle→knee from vertical, + when the knee is ahead along f', () => {
  const L = leg([1.25, 0.3], 20, 20);
  const s = setup(() => standing({ lHip: L.hip, lKne: L.knee, lAnk: L.ank }));
  // The shin leans the knee backward (ankle ahead): −20° toward f = +1.
  assertAlmostEquals(num(val(s, 'shinAngle', { side: 'left' })), -20, EPS);
  const back = setup(() => standing({ lHip: L.hip, lKne: L.knee, lAnk: L.ank }), { f: -1 });
  assertAlmostEquals(num(val(back, 'shinAngle', { side: 'left' })), 20, EPS);
});

Deno.test('elbowAng: shoulder–elbow–wrist angle of the chosen arm', () => {
  const sho: XY = [1.1, 0.68];
  const elb = polar(sho, 0.15, 180);
  const s = setup(() => standing({ rElb: elb, rWri: polar(elb, 0.15, 120) }));
  assertAlmostEquals(num(val(s, 'elbowAng', { arm: 'racket' })), 120, EPS);
  assertAlmostEquals(num(val(s, 'elbowAng', { arm: 'nonRacket' })), 180, EPS);
});

Deno.test('trunkLean: signed toward f in side view, lateral magnitude in behind/front', () => {
  const frame = () => standing({ neck: polar([1, 0.5], 0.2, 30) });
  assertAlmostEquals(num(val(setup(frame), 'trunkLean')), 30, EPS);
  assertAlmostEquals(num(val(setup(frame, { f: -1 }), 'trunkLean')), -30, EPS);
  assertAlmostEquals(num(val(setup(frame, { view: 'behind' }), 'trunkLean')), 30, EPS);
  const leftLean = () => standing({ neck: polar([1, 0.5], 0.2, -30) });
  assertAlmostEquals(num(val(setup(leftLean, { view: 'front' }), 'trunkLean')), 30, EPS);
});

Deno.test('stanceW, stagger: ankle spread in T, stanceW relative to SWmax', () => {
  // Shoulders 0.2 apart = 1 T (≥ the 0.7 floor, so SWmax = 1); ankles 0.3 apart = 1.5 T.
  const s = setup(() => standing({ lAnk: [0.85, 0.1], rAnk: [1.15, 0.1] }), { view: 'behind' });
  assertAlmostEquals(s.ctx.swMax, 1, EPS);
  assertAlmostEquals(num(val(s, 'stanceW', {}, 'ready')), 1.5, EPS);
  assertAlmostEquals(num(val(s, 'stagger', {}, 'ready')), 1.5, EPS);
  // Narrow shoulders (0.4 T) fall back to the anatomical floor of 0.7 T.
  const narrow = setup(() =>
    standing({ lSho: [0.96, 0.68], rSho: [1.04, 0.68], lAnk: [0.85, 0.1], rAnk: [1.15, 0.1] })
  );
  assertAlmostEquals(narrow.ctx.swMax, 0.7, EPS);
  assertAlmostEquals(num(val(narrow, 'stanceW')), 1.5 / 0.7, EPS);
});

Deno.test('turn: acos (behind) / asin (side) of shoulder width over SWmax; hip line uses hip width', () => {
  // Square (1 T wide) for the first 2 s, then turned to half width.
  const frame = (t: number) =>
    t < 2 ? standing() : standing({ lSho: [0.95, 0.68], rSho: [1.05, 0.68], lHip: [0.98, 0.5], rHip: [1.02, 0.5] });
  const phases = { ...STD_PHASES, contact: 3, bsEnd: 2.8, ftStop: 3.2, recovery: 3.5 };
  const b = setup(frame, { view: 'behind', phases });
  assertAlmostEquals(num(val(b, 'turn', { line: 'shoulder' })), 60, EPS);
  assertAlmostEquals(num(val(b, 'turn', { line: 'shoulder' }, 'ready')), 0, EPS);
  const s = setup(frame, { view: 'side', phases });
  assertAlmostEquals(num(val(s, 'turn', { line: 'shoulder' })), 30, EPS);
  // Hips 0.4 T → 0.2 T; the hip width floor (0.5 T) is the reference.
  assertAlmostEquals(b.ctx.hwMax, 0.5, EPS);
  assertAlmostEquals(num(val(b, 'turn', { line: 'hip' })), Math.acos(0.4) * 180 / Math.PI, EPS);
});

Deno.test('wristH, reach, elbowRel: heights in T (reach relative to the arm length)', () => {
  const s = setup(() => standing({ rElb: [1.1, 0.83], rWri: [1.1, 0.98], lWri: [0.9, 0.9] }));
  assertAlmostEquals(num(val(s, 'wristH', { arm: 'racket' })), 2.4, EPS);
  assertAlmostEquals(num(val(s, 'wristH', { arm: 'nonRacket' })), 2.0, EPS);
  // Arm length is 0.3 = 1.5 T everywhere, the wrist is 1.5 T above the shoulder: full reach.
  assertAlmostEquals(s.ctx.lArm.racket, 1.5, EPS);
  assertAlmostEquals(num(val(s, 'reach', { arm: 'racket' })), 1, EPS);
  assertAlmostEquals(num(val(s, 'elbowRel', { arm: 'racket' })), 0.75, EPS);
  assertAlmostEquals(num(val(s, 'elbowRel', { arm: 'nonRacket' })), -0.75, EPS);
});

Deno.test('wristFwd (sign f) and wristLat (sign h: view, handedness, mirrored source)', () => {
  const frame = () => standing({ rWri: [1.3, 0.6], lWri: [0.7, 0.6] });
  assertAlmostEquals(num(val(setup(frame), 'wristFwd')), 1, EPS);
  assertAlmostEquals(num(val(setup(frame, { f: -1 }), 'wristFwd')), -1, EPS);
  assertAlmostEquals(num(val(setup(frame, { view: 'behind' }), 'wristLat')), 1.5, EPS);
  assertAlmostEquals(num(val(setup(frame, { view: 'front' }), 'wristLat')), -1.5, EPS);
  assertAlmostEquals(num(val(setup(frame, { view: 'behind', handedness: 'left' }), 'wristLat')), 1.5, EPS);
  assertAlmostEquals(num(val(setup(frame, { view: 'behind', mirrored: true }), 'wristLat')), -1.5, EPS);
});

Deno.test('vWrist, vyWrist, vRoot: SG-derivative velocities in T/s', () => {
  const frame = (t: number) => standing({ rWri: [1.1 + 0.4 * t, 0.38 + 0.2 * t], root: [1 + 0.1 * t, 0.5] });
  for (const hz of [30, 60] as const) {
    const s = setup(frame, { hz });
    // 1e-5: the 30 Hz grid rounds 33333.3 µs steps to whole µs while SG assumes exactly 1/hz.
    assertAlmostEquals(num(val(s, 'vWrist', { arm: 'racket' })), Math.hypot(2, 1), 1e-5);
    assertAlmostEquals(num(val(s, 'vWrist', { arm: 'racket', stat: 'peak' })), Math.hypot(2, 1), 1e-5);
    assertAlmostEquals(num(val(s, 'vyWrist', { arm: 'racket' })), 1, 1e-5);
    assertAlmostEquals(num(val(s, 'vRoot')), 0.5, 1e-5);
    assertAlmostEquals(num(val(s, 'vWrist', { arm: 'nonRacket' })), 0, 1e-5);
  }
});

Deno.test('bsLen / ftLen: racket-wrist path length in T (bsLen without swingStart halves conf)', () => {
  const frame = (t: number) => standing({ rWri: [1.1 + 0.4 * t, 0.38] }); // 2 T/s
  const s = setup(frame);
  assertAlmostEquals(num(val(s, 'bsLen', {}, 'window')), 1.0, 1e-9); // swingStart 1.5 → contact 2.0
  assertAlmostEquals(num(val(s, 'ftLen', {}, 'window')), 0.6, 1e-9); // contact 2.0 → ftStop 2.3
  const noSwing = setup(frame, { phases: { ...STD_PHASES, swingStart: null } });
  const r = val(noSwing, 'bsLen', {}, 'window');
  assertAlmostEquals(num(r), 0.4, 1e-9); // bsEnd 1.8 → contact
  assertAlmostEquals(r.conf, 0.45, EPS);
});

Deno.test('ftCross: wrist crosses the neck–root line to the non-racket side within withinS', () => {
  const frame = (t: number) => standing({ rWri: [1.3 - (t - 2), 0.6] }); // reaches the midline at t = 2.3 s
  const s = setup(frame, { view: 'behind' });
  assertEquals(val(s, 'ftCross', { withinS: 0.6 }, 'window').value, true);
  assertEquals(val(s, 'ftCross', { withinS: 0.2 }, 'window').value, false);
  // Front view mirrors the lateral sign: the racket side is image-left, so the mirrored motion crosses.
  const mirroredMotion = (t: number) => standing({ rWri: [0.7 + (t - 2), 0.6] });
  assertEquals(val(setup(mirroredMotion, { view: 'front' }), 'ftCross', { withinS: 0.6 }, 'window').value, true);
  assertEquals(val(setup(mirroredMotion, { view: 'front' }), 'ftCross', { withinS: 0.2 }, 'window').value, false);
});

Deno.test('wShift: root between rear (0) and front (1) ankle along f; undefined with feet together', () => {
  const frame = () => standing({ lAnk: [1.15, 0.1], rAnk: [0.85, 0.1], root: [1.06, 0.5] });
  assertAlmostEquals(num(val(setup(frame), 'wShift')), 0.7, 1e-9);
  assertAlmostEquals(num(val(setup(frame, { f: -1 }), 'wShift')), 0.3, 1e-9);
  assertEquals(val(setup(() => standing({ lAnk: [1, 0.1], rAnk: [1.01, 0.1] })), 'wShift').value, null);
});

Deno.test('feetStill: max ankle displacement from ready to contact, in T', () => {
  const s = setup((t) => standing({ lAnk: [0.96 + 0.02 * t, 0.1] }));
  assertAlmostEquals(num(val(s, 'feetStill', {}, 'window')), 0.1, 1e-9); // ready 1.0 → contact 2.0
});

Deno.test('hop: both ankles ≥ 0.1 T and root ≥ 0.05 T, take-offs ≤ 70 ms apart, airtime 0.1–0.4 s', () => {
  const bump = (
    t: number,
    a: number,
    b: number,
  ) => (t <= a || t >= b ? 0 : Math.sin((Math.PI * (t - a)) / (b - a)) ** 2);
  const T = 0.2;
  const make = (o: { ank?: number; root?: number; right?: boolean; dur?: number; lag?: number }) => (t: number) => {
    const d = o.dur ?? 0.25, lag = o.lag ?? 0;
    const la = (o.ank ?? 0.15) * T * bump(t, 1.0, 1.0 + d);
    const ra = (o.right === false ? 0 : (o.ank ?? 0.15)) * T * bump(t, 1.0 + lag, 1.0 + lag + d);
    const rr = (o.root ?? 0.08) * T * bump(t, 0.98, 1.0 + d);
    return standing({ lAnk: [0.96, 0.1 + la], rAnk: [1.04, 0.1 + ra], root: [1, 0.5 + rr] });
  };
  const phases = { ...STD_PHASES, ready: 1.1, contact: 2.2, bsEnd: 2.0, ftStop: 2.4 };
  for (const hz of [30, 60] as const) {
    const yes = val(setup(make({}), { phases, hz }), 'hop', {}, 'window');
    assertEquals(yes.value, true, `${hz} Hz`);
    assert(yes.atUs !== undefined && Math.abs(yes.atUs - 1_000_000 - 1_000_000) < 100_000, `take-off ${yes.atUs}`);
  }
  assertEquals(val(setup(make({ ank: 0.05 }), { phases }), 'hop', {}, 'window').value, false, 'too low');
  assertEquals(val(setup(make({ right: false }), { phases }), 'hop', {}, 'window').value, false, 'one ankle');
  assertEquals(val(setup(make({ root: 0 }), { phases }), 'hop', {}, 'window').value, false, 'root stays');
  assertEquals(val(setup(make({ lag: 0.15 }), { phases }), 'hop', {}, 'window').value, false, 'onsets apart');
  assertEquals(val(setup(make({ dur: 0.9 }), { phases }), 'hop', {}, 'window').value, false, 'too long');
  // The params lower the thresholds.
  const low = val(setup(make({ ank: 0.05, root: 0.03 }), { phases }), 'hop', {
    minAnkleRiseT: 0.04,
    minRootRiseT: 0.02,
  }, 'window');
  assertEquals(low.value, true);
});

Deno.test('moveOnset: horizontal root speed > 0.8 T/s for ≥ 3 frames after contact', () => {
  const moving = setup((t) => standing({ root: [1 + Math.max(0, t - 2.1) * 0.2, 0.5] }));
  const r = val(moving, 'moveOnset', {}, 'window');
  assertEquals(r.value, true);
  assert(r.atUs !== undefined && r.atUs > 3_000_000 && r.atUs < 3_250_000, `onset ${r.atUs}`);
  assertEquals(val(setup(() => standing()), 'moveOnset', {}, 'window').value, false);
});

Deno.test('baseErr: distance from the ready-window median root, in T', () => {
  const frame = (t: number) => standing({ root: [1 + Math.min(Math.max(t - 2, 0), 0.5) * 0.2, 0.5] });
  const s = setup(frame);
  assertAlmostEquals(num(val(s, 'baseErr', {}, 'recovery')), 0.5, 1e-9);
  assertAlmostEquals(num(val(s, 'baseErr', {}, 'ready')), 0, 1e-9);
  // No ready window: the ready frame is the base, with half confidence.
  const nw = setup(frame, { phases: { ...STD_PHASES, readyWindow: null } });
  const r = val(nw, 'baseErr', {}, 'recovery');
  assertAlmostEquals(num(r), 0.5, 1e-9);
  assertAlmostEquals(r.conf, 0.45, EPS);
});

Deno.test('headStill: nose displacement over [−0.2, +0.1] s around contact, in T', () => {
  const s = setup((t) => standing({ nose: [1.04 + 0.04 * t, 0.76] }));
  assertAlmostEquals(num(val(s, 'headStill', {}, 'window')), 0.06, 1e-9);
});

Deno.test('phases: ready is the window median; missing ready window / recovery / joints give null', () => {
  // Wrist height ramps through the ready window [0.75, 1.25]: the median equals the value at its centre.
  const s = setup((t) => standing({ rWri: [1.1, 0.38 + 0.1 * t] }));
  assertAlmostEquals(num(val(s, 'wristH', { arm: 'racket' }, 'ready')), (0.38 + 0.1 - 0.5) / 0.2, 1e-9);
  assertAlmostEquals(num(val(s, 'wristH', { arm: 'racket' }, 'contact+0.2')), (0.38 + 0.22 - 0.5) / 0.2, 1e-9);
  const noReady = setup(() => standing(), { phases: { ...STD_PHASES, readyWindow: null } });
  assertEquals(val(noReady, 'kneeFlex', {}, 'ready'), { value: null, conf: 0 });
  const noRec = setup(() => standing(), { phases: { ...STD_PHASES, recovery: null } });
  assertEquals(val(noRec, 'wristH', {}, 'recovery').value, null);
  const late = setup(() => standing(), { phases: { ...STD_PHASES, contact: 3.9, ftStop: 3.95, recovery: null } });
  assertEquals(val(late, 'wristH', {}, 'contact+0.2').value, null);
  const noWrist = setup(() => ({ ...standing(), rWri: undefined }));
  assertEquals(val(noWrist, 'wristH'), { value: null, conf: 0 });
});
