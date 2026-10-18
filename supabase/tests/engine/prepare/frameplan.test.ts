/** Frame plan geometry (DESIGN.md §6.2 step 13, D9): crop snapping and the stroke crop contents. */
import { assert, assertAlmostEquals, assertEquals } from '@std/assert';
import { planFrames, snapCrop, strokeCrop } from '@shared/engine/frameplan.ts';
import { phasesAt, standing, trackFrom } from '../scoring/_track.ts';

const FHD = { w: 1920, h: 1080 };
const aspect = (c: { w: number; h: number }, d = FHD) => (c.w * d.w) / (c.h * d.h);
const inside = (c: { x: number; y: number; w: number; h: number }) =>
  c.x >= 0 && c.y >= 0 && c.x + c.w <= 1 + 1e-9 && c.y + c.h <= 1 + 1e-9;

Deno.test('snapCrop: grows the short side to 4:3 / 3:4 around the centre', () => {
  const tall = snapCrop({ x0: 0.45, y0: 0.2, x1: 0.55, y1: 0.8 }, FHD); // 192 × 648 px → 3:4
  assertAlmostEquals(aspect(tall), 3 / 4, 1e-3);
  assertAlmostEquals(tall.h, 0.6, 1e-4);
  assertAlmostEquals(tall.x + tall.w / 2, 0.5, 1e-4);
  const wide = snapCrop({ x0: 0.1, y0: 0.4, x1: 0.5, y1: 0.6 }, FHD); // 768 × 216 px → 4:3
  assertAlmostEquals(aspect(wide), 4 / 3, 1e-3);
  assertAlmostEquals(wide.w, 0.4, 1e-4);
});

Deno.test('snapCrop: shifts inside the frame, shrinks when too big, handles portrait video and null', () => {
  const edge = snapCrop({ x0: -0.1, y0: 0.7, x1: 0.1, y1: 1.2 }, FHD);
  assert(inside(edge));
  assertAlmostEquals(aspect(edge), 3 / 4, 1e-3);
  const huge = snapCrop({ x0: -1, y0: -1, x1: 2, y1: 2 }, FHD);
  assert(inside(huge));
  assertEquals(huge.h, 1);
  assertAlmostEquals(aspect(huge), 4 / 3, 1e-3);
  const portrait = { w: 1080, h: 1920 };
  const p = snapCrop({ x0: 0.1, y0: 0.3, x1: 0.9, y1: 0.5 }, portrait);
  assert(inside(p));
  assertAlmostEquals(aspect(p, portrait), 4 / 3, 1e-3);
  const n = snapCrop(null, FHD);
  assert(inside(n));
  assertEquals(n.h, 1);
});

Deno.test('strokeCrop covers the target boxes and the racket around the wrist; overview is larger', () => {
  // Wrist sweeps 0.3 (frame-height units) to the right over the stroke.
  const track = trackFrom((t) => standing({ rWri: [1.1 + 0.3 * Math.min(1, Math.max(0, t - 1)), 0.4] }));
  const p = phasesAt(track, { ready: 1, bsEnd: 1.5, contact: 1.8, ftStop: 2 });
  const crop = strokeCrop(track.raw, p, 'rWri', 1.4);
  const T = track.raw.torsoT;
  // Rightmost wrist (x ≈ 1.4) plus 1.4 T must be inside the crop (normalized x = frame-height x / aspect).
  const right = (1.1 + 0.3 + 1.4 * T) / track.raw.aspect;
  assert(crop.x + crop.w >= right - 1e-3, `crop ends at ${crop.x + crop.w}, wrist reach ${right}`);
  assert(inside(crop));
  const frames = planFrames({
    raw: track.raw,
    phases: new Map([[1, p]]),
    best: 1,
    worst: null,
    handedness: 'right',
    sport: 'badminton',
    frameMode: 'frames',
  });
  assertEquals(frames.map((f) => f.frameId), ['F1', 'F2', 'F3', 'F4', 'F5']);
  const f5 = frames[4];
  assertEquals([f5.phase, f5.tUs], ['overview', p.contact.snappedUs]);
  assert(f5.crop.w * f5.crop.h > 0, 'overview crop');
  // Pose-only: same frames, nothing uploaded.
  const po = planFrames({
    raw: track.raw,
    phases: new Map([[1, p]]),
    best: 1,
    worst: null,
    handedness: 'right',
    sport: 'pickleball',
    frameMode: 'pose_only',
  });
  assert(po.every((f) => !f.upload));
});
