import { assert, assertEquals } from '@std/assert';
import { FLAG_COASTED, JOINT_INDEX } from '@shared/contracts/index.ts';
import { computePhases, PHASE_CONSTANTS, snapToSampled } from '@shared/engine/phases.ts';
import { segmentStrokes } from '@shared/engine/segment.ts';
import type { PhasePoint, SmoothTrack, StrokePhases } from '@shared/engine/types.ts';
import { generateSyntheticPose } from '../../../../scripts/gen-synthetic-pose.ts';
import { SYNTHETIC_FIXTURES } from '../../../../scripts/gen-synthetic-pose.ts';
import { LAUNCH_SEGMENT_PARAMS, loadSynthetic, runSignal } from './_pipeline.ts';

function phasesOf(pose: unknown, skill: keyof typeof LAUNCH_SEGMENT_PARAMS) {
  const run = runSignal(pose);
  const h = run.pose.session.handedness;
  const seg = segmentStrokes(run.smooth, h, LAUNCH_SEGMENT_PARAMS[skill]);
  assert(seg.ok);
  return { run, seg, phases: computePhases(run.smooth, seg.strokes, h) };
}

function points(p: StrokePhases): PhasePoint[] {
  return [p.swingStart, p.ready, p.bsEnd, p.contact, p.ftStop, p.recovery].filter((x): x is PhasePoint => !!x);
}

Deno.test('phases follow the v1.0 definitions and order on every fixture', async () => {
  const P = PHASE_CONSTANTS;
  for (const { name, opts } of SYNTHETIC_FIXTURES) {
    const { pose } = await loadSynthetic(name);
    const { run, seg, phases } = phasesOf(pose, opts.skill);
    const v = run.smooth.vel[run.pose.session.handedness === 'left' ? 'lWri' : 'rWri'].speed;
    assertEquals(phases.length, seg.strokes.length);
    phases.forEach((p, k) => {
      const s = seg.strokes[k];
      const tc = s.tContactUs;
      assertEquals(p.strokeId, s.id);
      assertEquals(p.contact.tUs, tc);
      // bsEnd: argmin v in [tc−0.6, tc−0.05].
      assert(p.bsEnd.tUs >= tc + P.bsFromS * 1e6 - 17_000 && p.bsEnd.tUs <= tc + P.bsToS * 1e6, name);
      // ftStop: in (tc, tc+0.8], below max(0.5, 0.2·vPeak) unless it is the tc+0.8 fallback.
      assert(p.ftStop.tUs > tc && p.ftStop.tUs <= tc + P.ftMaxS * 1e6 + 1, name);
      const vStop = v[p.ftStop.index] as number;
      assert(vStop < Math.max(0.5, 0.2 * s.vPeak) || p.ftStop.tUs >= tc + P.ftMaxS * 1e6 - 17_000, name);
      if (p.recovery) assertEquals(p.recovery.tUs, tc + 1_000_000);
      if (p.swingStart) {
        assert(p.swingStart.tUs < p.bsEnd.tUs && p.swingStart.tUs >= p.bsEnd.tUs - 1_000_000);
        assert((v[p.swingStart.index] as number) < P.swingStartV);
      }
      assert(p.ready.tUs <= p.bsEnd.tUs, name);
      // Order and span on the snapped clock.
      assert(p.ready.snappedUs <= p.bsEnd.snappedUs && p.bsEnd.snappedUs <= p.contact.snappedUs, name);
      assert(p.contact.snappedUs <= p.ftStop.snappedUs, name);
      assert(p.tStartUs <= p.contact.snappedUs && p.contact.snappedUs <= p.tEndUs, name);
      if (p.readyWindow) {
        assert(p.readyAssessable);
        assert(p.readyWindow.endUs - p.readyWindow.startUs >= P.readyMinS * 1e6 - 34_000);
        assert(p.ready.index >= p.readyWindow.startIndex && p.ready.index <= p.readyWindow.endIndex);
        if (k > 0) assert(p.readyWindow.startUs >= phases[k - 1].ftStop.tUs + P.readyAfterPrevFtStopS * 1e6);
      }
    });
  }
});

Deno.test('every phase time is snapped to a sampled, non-coasted PTS with the racket wrist observed', async () => {
  for (const { name, opts } of SYNTHETIC_FIXTURES) {
    const { pose } = await loadSynthetic(name);
    const { run, phases } = phasesOf(pose, opts.skill);
    const raw = run.cleaned;
    const wrist = run.pose.session.handedness === 'left' ? 'lWri' : 'rWri';
    for (const p of phases) {
      for (const pt of [...points(p), { snappedUs: p.tStartUs }, { snappedUs: p.tEndUs }]) {
        const k = raw.tUs.indexOf(pt.snappedUs);
        assert(k >= 0, `${name}: ${pt.snappedUs} is not a sampled PTS`);
        assert(raw.joints[wrist].x[k] !== null, `${name}: wrist missing at the snapped frame`);
        assertEquals(raw.flags[k] & FLAG_COASTED, 0);
      }
    }
  }
});

Deno.test('snapping skips coasted frames and frames whose wrist was dropped', () => {
  const { pose } = generateSyntheticPose({ skill: 'bd.clear_fh', hz: 30, seed: 61, dropouts: false, vfr: false });
  const p = structuredClone(pose) as { track: { tUs: number[]; flags: number[]; kp: number[][] } };
  const i = 60;
  const t = p.track.tUs[i];
  p.track.flags[i] = FLAG_COASTED;
  p.track.kp[i + 1].splice(JOINT_INDEX.rWri * 3, 3, 0, 0, 0);
  const run = runSignal(p);
  const raw = run.cleaned;
  // The coasted frame itself is never returned; the nearer good neighbour is.
  assertEquals(snapToSampled(raw, t - 1000), raw.tUs[i - 1]);
  assertEquals(snapToSampled(raw, t + 1000), raw.tUs[i + 1]);
  assertEquals(snapToSampled(raw, raw.tUs[i + 1], ['rWri']), raw.tUs[i + 2]);
  assertEquals(snapToSampled(raw, raw.tUs[i + 1]), raw.tUs[i + 1]); // any observed joint is enough by default
  assertEquals(snapToSampled(raw, -5), raw.tUs[0]);
  assertEquals(snapToSampled(raw, 1e12), raw.tUs[raw.tUs.length - 1]);
});

Deno.test('ready is not assessable when strokes follow too closely; times stay valid', () => {
  // Clears 1.2 s apart: prev ftStop + 0.3 s leaves < 0.2 s of [tc−1.2, tc−0.7].
  const { pose } = generateSyntheticPose({ skill: 'bd.clear_fh', hz: 60, seed: 62, spacingS: 1.2, strokes: 4 });
  const run = runSignal(pose);
  const seg = segmentStrokes(run.smooth, 'right', LAUNCH_SEGMENT_PARAMS['bd.clear_fh']);
  assert(seg.ok && seg.strokes.length >= 2);
  const phases = computePhases(run.smooth, seg.strokes, 'right');
  assert(phases[0].readyAssessable);
  const later = phases.slice(1);
  assert(later.some((p) => !p.readyAssessable));
  for (const p of later.filter((x) => !x.readyAssessable)) {
    assertEquals(p.readyWindow, null);
    assert(p.ready.tUs <= p.bsEnd.tUs);
  }
});

Deno.test('recovery is null past the end of the track', () => {
  const { pose } = generateSyntheticPose({ skill: 'pb.serve', hz: 30, seed: 63 });
  const run = runSignal(pose);
  const seg = segmentStrokes(run.smooth, 'right', LAUNCH_SEGMENT_PARAMS['pb.serve']);
  assert(seg.ok);
  // Truncate the grid right after the last contact.
  const last = seg.strokes[seg.strokes.length - 1];
  const cut = last.peakIndex + 20;
  const short: SmoothTrack = { ...run.smooth, tUs: run.smooth.tUs.slice(0, cut) };
  const phases = computePhases(short, seg.strokes, 'right');
  assertEquals(phases[phases.length - 1].recovery, null);
  assert(phases[0].recovery !== null);
});
