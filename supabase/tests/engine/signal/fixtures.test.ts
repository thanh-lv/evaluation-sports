import { assert, assertEquals } from '@std/assert';
import { PoseV1 } from '@shared/contracts/index.ts';
import { prettyJson } from '../../../../scripts/_lib/json.ts';
import { generateSyntheticPose, SYNTHETIC_FIXTURES } from '../../../../scripts/gen-synthetic-pose.ts';

const DIR = new URL('../../../../shared/fixtures/pose/', import.meta.url);

Deno.test('synthetic pose fixtures are valid pose.v1, < 300 KB and in sync with the generator', async () => {
  for (const { name, opts } of SYNTHETIC_FIXTURES) {
    const text = await Deno.readTextFile(new URL(`${name}.json`, DIR));
    const truthText = await Deno.readTextFile(new URL(`${name}.truth.json`, DIR));
    assert(text.length < 300_000, `${name}: ${text.length} bytes`);
    const pose = PoseV1.parse(JSON.parse(text));
    assertEquals(pose.video.analysisHz, opts.hz);
    assertEquals(pose.video.mirrored, opts.mirrored ?? false);
    const regenerated = generateSyntheticPose(opts);
    assertEquals(text, prettyJson(regenerated.pose), `${name} is stale: run scripts/gen-synthetic-pose.ts`);
    assertEquals(truthText, prettyJson(regenerated.truth));
  }
});

Deno.test('the generator is deterministic and covers every launch skill at both rates', () => {
  const a = generateSyntheticPose({ skill: 'pb.drop3', hz: 60, seed: 5 });
  const b = generateSyntheticPose({ skill: 'pb.drop3', hz: 60, seed: 5 });
  assertEquals(a, b);
  const skills = new Set(SYNTHETIC_FIXTURES.map((f) => f.opts.skill));
  assertEquals(skills.size, 6);
  assertEquals(new Set(SYNTHETIC_FIXTURES.map((f) => f.opts.hz)), new Set([30, 60]));
  // Overhead peaks are in the 20–30 T/s range the Hampel/segmentation tests rely on.
  assert(a.truth.peakSpeedsTps.every((v) => v > 0));
  const smash = generateSyntheticPose({ skill: 'bd.smash', hz: 30, seed: 5 });
  assert(smash.truth.peakSpeedsTps.every((v) => v >= 20 && v <= 30));
});
