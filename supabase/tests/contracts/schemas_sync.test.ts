import { assert, assertEquals } from '@std/assert';
import { auditCoachOutputSchema, type JsonSchema } from '@shared/contracts/index.ts';
import { generateSchemas } from '../../../scripts/gen-schemas.ts';
import { prettyJson } from '../../../scripts/_lib/json.ts';

const DIR = new URL('../../../shared/schemas/', import.meta.url);

Deno.test('shared/schemas are in sync with the Zod contracts', async () => {
  for (const [file, schema] of generateSchemas()) {
    const onDisk = await Deno.readTextFile(new URL(file, DIR));
    assertEquals(onDisk, prettyJson(schema), `${file} is stale: run make schemas`);
  }
});

Deno.test('committed coach-output schemas pass the audit', async () => {
  for (const sport of ['badminton', 'pickleball']) {
    const schema = JSON.parse(await Deno.readTextFile(new URL(`coach-output.${sport}.v1.json`, DIR))) as JsonSchema;
    assertEquals(auditCoachOutputSchema(schema), []);
    assert(schema.$defs?.CheckpointId);
  }
});
