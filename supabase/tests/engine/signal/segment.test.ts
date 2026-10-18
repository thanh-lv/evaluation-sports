import { assert, assertEquals } from '@std/assert';
import { FLAG_REACQUIRED, JOINT_INDEX, MAX_STROKES } from '@shared/contracts/index.ts';
import { qualityRejection, segmentStrokes } from '@shared/engine/segment.ts';
import { generateSyntheticPose, LAUNCH_SKILLS, type LaunchSkill } from '../../../../scripts/gen-synthetic-pose.ts';
import { LAUNCH_SEGMENT_PARAMS, loadSynthetic, runSignal } from './_pipeline.ts';
import { SYNTHETIC_FIXTURES } from '../../../../scripts/gen-synthetic-pose.ts';

/** Greedy one-to-one matching of detected to true contacts within `tolUs`. */
function match(detected: number[], truth: number[], tolUs: number): { tp: number; errorsMs: number[] } {
  const used = new Set<number>();
  const errorsMs: number[] = [];
  for (const c of truth) {
    let best = -1;
    detected.forEach((d, k) => {
      if (!used.has(k) && Math.abs(d - c) <= tolUs && (best < 0 || Math.abs(d - c) < Math.abs(detected[best] - c))) {
        best = k;
      }
    });
    if (best >= 0) {
      used.add(best);
      errorsMs.push((detected[best] - c) / 1000);
    }
  }
  return { tp: used.size, errorsMs };
}

/** Synthetic contact-error bound per skill (slow, flat speed peaks are less precise). Real-clip targets are M4b's. */
const MAX_CONTACT_ERR_MS: Record<LaunchSkill, number> = {
  'bd.clear_fh': 35,
  'bd.smash': 35,
  'pb.serve': 35,
  'bd.serve_low': 50,
  'pb.drop3': 50,
  'pb.dink': 90,
};

Deno.test('segmentation recall and precision ≥ 0.95 per skill on generated clips (30 and 60 Hz)', () => {
  for (const skill of LAUNCH_SKILLS) {
    let tp = 0, truthN = 0, detN = 0;
    const errs: number[] = [];
    for (const hz of [30, 60] as const) {
      for (const seed of [41, 42, 43]) {
        const { pose, truth } = generateSyntheticPose({ skill, hz, seed });
        const seg = segmentStrokes(runSignal(pose).smooth, 'right', LAUNCH_SEGMENT_PARAMS[skill]);
        const det = seg.ok ? seg.strokes.map((s) => s.tContactUs) : [];
        const m = match(det, truth.contactsUs, 150_000);
        tp += m.tp;
        truthN += truth.contactsUs.length;
        detN += det.length;
        errs.push(...m.errorsMs);
      }
    }
    assert(tp / truthN >= 0.95, `${skill} recall ${tp}/${truthN}`);
    assert(tp / detN >= 0.95, `${skill} precision ${tp}/${detN}`);
    const worst = Math.max(...errs.map(Math.abs));
    assert(worst <= MAX_CONTACT_ERR_MS[skill], `${skill} contact error ${worst.toFixed(1)} ms`);
  }
});

Deno.test('segmentation finds every stroke of every committed fixture', async () => {
  for (const { name, opts } of SYNTHETIC_FIXTURES) {
    const { pose, truth } = await loadSynthetic(name);
    const seg = segmentStrokes(runSignal(pose).smooth, truth.declared, LAUNCH_SEGMENT_PARAMS[opts.skill]);
    assert(seg.ok, name);
    assertEquals(seg.strokes.length, truth.contactsUs.length, name);
    assertEquals(match(seg.strokes.map((s) => s.tContactUs), truth.contactsUs, 150_000).tp, truth.contactsUs.length);
    assertEquals(seg.strokes.map((s) => s.id), seg.strokes.map((_, k) => k + 1));
    assert(seg.strokes.every((s, k) => k === 0 || s.tPeakUs > seg.strokes[k - 1].tPeakUs));
    assert(seg.strokes.every((s) => s.contactIsEstimate));
  }
});

Deno.test('segmentation: contactOffsetMs shifts contact from the refined peak', () => {
  const { pose } = generateSyntheticPose({ skill: 'bd.smash', hz: 60, seed: 44 });
  const smooth = runSignal(pose).smooth;
  const base = segmentStrokes(smooth, 'right', { vmin: 4, nms: 0.8, contactOffsetMs: 0 });
  const shifted = segmentStrokes(smooth, 'right', { vmin: 4, nms: 0.8, contactOffsetMs: -25 });
  assert(base.ok && shifted.ok);
  base.strokes.forEach((s, k) => {
    assertEquals(s.tContactUs, Math.round(s.tPeakUs));
    assertEquals(shifted.strokes[k].tContactUs, Math.round(s.tPeakUs - 25_000));
  });
});

Deno.test('segmentation thresholds come from the skill params (vmin, NMS spacing, stroke limit)', () => {
  const { pose, truth } = generateSyntheticPose({ skill: 'pb.dink', hz: 30, seed: 45 });
  const smooth = runSignal(pose).smooth;
  const n = truth.contactsUs.length;
  // vmin above every swing → 422 no_strokes_detected.
  const none = segmentStrokes(smooth, 'right', { vmin: 50, nms: 0.8, contactOffsetMs: 0 });
  assertEquals(none.ok, false);
  if (!none.ok) assertEquals(none.code, 'no_strokes_detected');
  // NMS wider than the stroke spacing (1.8 s) suppresses neighbours.
  const wide = segmentStrokes(smooth, 'right', { vmin: 1.2, nms: 2.5, contactOffsetMs: 0 });
  assert(wide.ok && wide.strokes.length < n);
  assert(wide.candidates.some((c) => c.rejected === 'nms'));
  // Stroke limit keeps the fastest, in time order.
  const all = segmentStrokes(smooth, 'right', { vmin: 1.2, nms: 0.8, contactOffsetMs: 0 });
  const two = segmentStrokes(smooth, 'right', { vmin: 1.2, nms: 0.8, contactOffsetMs: 0 }, 2);
  assert(all.ok && two.ok);
  const fastest = [...all.strokes].sort((a, b) => b.vPeak - a.vPeak).slice(0, 2).map((s) => s.tPeakUs).sort();
  assertEquals(two.strokes.map((s) => s.tPeakUs), fastest);
  assertEquals(two.candidates.filter((c) => c.rejected === 'over_limit').length, n - 2);
  assertEquals(MAX_STROKES, 12);
});

Deno.test('segmentation caps at MAX_STROKES', () => {
  const { pose } = generateSyntheticPose({ skill: 'bd.smash', hz: 30, seed: 46, strokes: 14, spacingS: 2.0 });
  const seg = segmentStrokes(runSignal(pose).smooth, 'right', LAUNCH_SEGMENT_PARAMS['bd.smash']);
  assert(seg.ok);
  assertEquals(seg.strokes.length, MAX_STROKES);
  assertEquals(seg.candidates.filter((c) => c.rejected === 'over_limit').length, 2);
});

Deno.test('segmentation rejects strokes with a missing wrist, a re-acquisition, or mostly filled samples', () => {
  const { pose, truth } = generateSyntheticPose({ skill: 'bd.clear_fh', hz: 30, seed: 47, dropouts: false });
  const params = LAUNCH_SEGMENT_PARAMS['bd.clear_fh'];
  const target = truth.contactsUs[1];

  // Re-acquired inside ±0.2 s.
  const p1 = structuredClone(pose) as { track: { tUs: number[]; flags: number[]; kp: number[][] } };
  const k1 = p1.track.tUs.findIndex((t) => t > target + 100_000);
  p1.track.flags[k1] = FLAG_REACQUIRED;
  const s1 = segmentStrokes(runSignal(p1).smooth, 'right', params);
  assert(s1.ok);
  assertEquals(s1.strokes.length, truth.contactsUs.length - 1);
  assert(s1.candidates.some((c) => c.rejected === 'reacquired'));

  // Racket wrist missing in every other sample of ±0.2 s (50 % > 30 %; short gaps still get filled).
  const p2 = structuredClone(pose) as typeof p1;
  const wristK = JOINT_INDEX.rWri * 3;
  p2.track.tUs.forEach((t, i) => {
    if (Math.abs(t - target) <= 200_000 && i % 2 === 0) p2.track.kp[i].splice(wristK, 3, 0, 0, 0);
  });
  const s2 = segmentStrokes(runSignal(p2).smooth, 'right', params);
  assert(s2.ok);
  assertEquals(s2.strokes.length, truth.contactsUs.length - 1);
  assert(s2.candidates.some((c) => c.rejected === 'wrist_missing'));
  assertEquals(match(s2.strokes.map((s) => s.tContactUs), [target], 150_000).tp, 0);

  // Racket wrist lost for 0.27 s around contact (> 200 ms → never filled): that contact is never reported.
  const p3 = structuredClone(pose) as typeof p1;
  p3.track.tUs.forEach((t, i) => {
    if (Math.abs(t - target) <= 135_000) p3.track.kp[i].splice(wristK, 3, 0, 0, 0);
  });
  const s3 = segmentStrokes(runSignal(p3).smooth, 'right', params);
  assert(s3.ok);
  assertEquals(match(s3.strokes.map((s) => s.tContactUs), [target], 150_000).tp, 0);

  // Direct check of the interp rule: mark the wrist as gap-filled across ±0.1 s.
  const run = runSignal(pose);
  const seg = segmentStrokes(run.smooth, 'right', params);
  assert(seg.ok);
  const idx = seg.strokes[1].peakIndex;
  assertEquals(qualityRejection(run.smooth, 'rWri', idx), null);
  const filled = { ...run.smooth, interp: run.smooth.interp.slice() };
  for (let i = idx - 3; i <= idx + 3; i++) filled.interp[i] |= 1 << JOINT_INDEX.rWri;
  assertEquals(qualityRejection(filled, 'rWri', idx), 'interpolated');
});
