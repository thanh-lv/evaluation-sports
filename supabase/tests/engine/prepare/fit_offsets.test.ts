/** scripts/fit-contact-offsets.ts: CSV parsing, matching and the --check rule, using synthetic truth as labels. */
import { assert, assertAlmostEquals, assertEquals, assertThrows } from '@std/assert';
import type { PoseV1 } from '@shared/contracts/index.ts';
import { checkFit, fitOffsets, parseLabelsCsv } from '../../../../scripts/fit-contact-offsets.ts';
import { loadPose } from './_prepare.ts';

Deno.test('parseLabelsCsv: header, comments, validation', () => {
  const rows = parseLabelsCsv('# coach A\nclip,frame_tUs,label\n\nreal_bd_clear_01, 13910583 ,contact\n', 'a.csv');
  assertEquals(rows, [{ file: 'a.csv', line: 4, clip: 'real_bd_clear_01', frameTUs: 13910583, label: 'contact' }]);
  assertThrows(() => parseLabelsCsv('clip,t,label\n'), Error, 'header');
  assertThrows(() => parseLabelsCsv('clip,frame_tUs,label\nx,1.5,contact\n'), Error, 'integer');
  assertThrows(() => parseLabelsCsv('clip,frame_tUs,label\nx/y,1,contact\n'), Error, 'clip');
});

Deno.test('fitOffsets: median (label − peak) per skill; shifting labels shifts the fit; check within 1 frame', async () => {
  const name = 'synthetic_pb_dink_60';
  const { pose, truth } = await loadPose(name);
  const load = (_clip: string): Promise<PoseV1> => Promise.resolve(pose);
  const nearestPts = (t: number) => pose.track.tUs.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a));
  const rows = (shiftUs: number) =>
    truth.contactsUs.map((t, k) => ({
      file: 't',
      line: k,
      clip: name,
      frameTUs: nearestPts(t + shiftUs),
      label: 'contact',
    }));
  const [base] = await fitOffsets(rows(0), load);
  assertEquals([base.skill, base.labels, base.matched, base.recall, base.precision], ['pb.dink', 5, 5, 1, 1]);
  // Synthetic truth = true speed peak; smoothing moves the measured peak by a few ms at most.
  assert(Math.abs(base.offsetMs!) < 40, `offset ${base.offsetMs}`);
  const [shifted] = await fitOffsets(rows(100_000), load);
  assertAlmostEquals(shifted.offsetMs! - base.offsetMs!, 100, 17);
  assertEquals(checkFit({ ...base, offsetMs: base.rubricOffsetMs + 16 }), true);
  assertEquals(checkFit({ ...base, offsetMs: base.rubricOffsetMs + 17 }), false);
  assertEquals(checkFit({ ...base, offsetMs: null }), false);
  // Labels far from any peak are unmatched.
  const [far] = await fitOffsets(rows(400_000), load);
  assertEquals(far.matched, 0);
});
