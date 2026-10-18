import { assert, assertAlmostEquals, assertEquals, assertThrows } from '@std/assert';
import { JOINT_INDEX, JOINT_ORDER, PoseV1 } from '@shared/contracts/index.ts';
import { normalizePose, torsoUnit } from '@shared/engine/normalize.ts';
import { EngineRejection } from '@shared/engine/types.ts';
import { clone, loadFixture } from '../../_helpers/fixtures.ts';
import { loadSynthetic } from './_pipeline.ts';

const minimal = PoseV1.parse(await loadFixture('pose/synthetic_minimal.json'));

Deno.test('normalize: aspect-corrected frame-height units with y up', () => {
  const raw = normalizePose(minimal);
  const aspect = 1920 / 1080;
  assertAlmostEquals(raw.aspect, aspect, 1e-12);
  const k = JOINT_INDEX.neck * 3;
  const row = minimal.track.kp[0];
  assertAlmostEquals(raw.joints.neck.x[0] as number, (row[k] / 1000) * aspect, 1e-12);
  assertAlmostEquals(raw.joints.neck.y[0] as number, 1 - row[k + 1] / 1000, 1e-12);
  assertAlmostEquals(raw.joints.neck.c[0], row[k + 2] / 100, 1e-12);
  // The nose is above the neck: larger y in the y-up frame.
  assert((raw.joints.nose.y[0] as number) > (raw.joints.neck.y[0] as number));
  assertEquals(raw.tUs, minimal.track.tUs);
  assertEquals(raw.mirrorSwapApplied, false);
});

Deno.test('normalize: confidence < 0.3 and the 0,0,0 sentinel are missing', () => {
  const pose = clone(minimal);
  const k = JOINT_INDEX.rWri * 3;
  pose.track.kp[5][k + 2] = 29; // c = 0.29 → missing (D8)
  pose.track.kp[6][k + 2] = 30; // c = 0.30 → kept
  const raw = normalizePose(pose);
  assertEquals(raw.joints.rWri.x[5], null);
  assertEquals(raw.joints.rWri.c[5], 0);
  assert(raw.joints.rWri.x[6] !== null);
  assertEquals(raw.joints.lEar.x[42], null); // fixture's 0,0,0 frames
});

Deno.test('normalize: T is the median |neck − root|, with the shoulder-mid/hip-mid fallback', () => {
  const raw = normalizePose(minimal);
  // Fixture: neck (500,320), root (500,520) → 0.2 frame heights (± jitter).
  assertAlmostEquals(raw.torsoT, 0.2, 0.01);
  // Without neck/root, the fallback (shoulders y=330, hips y=520 → 0.19) is used.
  const joints = structuredClone(raw.joints);
  for (const j of ['neck', 'root'] as const) joints[j].x.fill(null);
  assertAlmostEquals(torsoUnit(joints, raw.tUs.length), 0.19, 0.01);
});

Deno.test('normalize: rejects a track with no measurable torso', () => {
  const pose = clone(minimal);
  for (const row of pose.track.kp) {
    for (const j of ['neck', 'root', 'lSho', 'rSho'] as const) row[JOINT_INDEX[j] * 3 + 2] = 0;
  }
  const err = assertThrows(() => normalizePose(pose), EngineRejection);
  assertEquals(err.code, 'low_visibility');
});

Deno.test('normalize: synthetic fixtures report the model torso unit', async () => {
  const { pose, truth } = await loadSynthetic('synthetic_bd_clear_fh_60');
  const raw = normalizePose(PoseV1.parse(pose));
  assertAlmostEquals(raw.torsoT, truth.torsoT, 0.01 * truth.torsoT + 0.002);
  assertEquals(Object.keys(raw.joints), [...JOINT_ORDER]);
});
