/**
 * Golden prepare responses (M4d): shared/fixtures/prepare/<synthetic fixture>.json must equal what the engine
 * produces now. After an intended engine change, regenerate with
 *   deno run -A --config supabase/functions/deno.json scripts/replay.ts --golden
 * and bump ALGO_VERSION when numbers moved.
 */
import { assertEquals } from '@std/assert';
import { PrepareResponseV1 } from '@shared/contracts/index.ts';
import { loadFixture } from '../../_helpers/fixtures.ts';
import { SYNTHETIC_FIXTURES } from '../../../../scripts/gen-synthetic-pose.ts';
import { goldenText } from '../../../../scripts/replay.ts';

for (const { name } of SYNTHETIC_FIXTURES) {
  Deno.test(`golden prepare response ${name}`, async () => {
    const file = new URL(`../../../../shared/fixtures/prepare/${name}.json`, import.meta.url);
    const expected = await Deno.readTextFile(file);
    assertEquals(await goldenText(name), expected, `${name} changed: run scripts/replay.ts --golden if intended`);
    PrepareResponseV1.parse(await loadFixture(`prepare/${name}.json`));
  });
}
