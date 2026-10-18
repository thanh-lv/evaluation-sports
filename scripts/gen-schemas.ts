/**
 * Exports every contract to shared/schemas/*.json and audits the Claude output schemas (DESIGN.md §7, M1).
 *
 *   deno run -A --config supabase/functions/deno.json scripts/gen-schemas.ts           # write
 *   deno run -A --config supabase/functions/deno.json scripts/gen-schemas.ts --check   # fail if out of sync
 *
 * Request contracts are exported in `input` mode (what clients may send), responses in `output` mode.
 * Zod refinements (superRefine) are not representable in JSON Schema; the Deno tests cover them.
 */
import { z } from 'zod';
import {
  auditCoachOutputSchema,
  buildCoachOutputSchema,
  CleanTrackV1Structure,
  CoachResultV1Structure,
  coachSchemaCatalogFromRubric,
  type JsonSchema,
  PoseV1Structure,
  PrepareResponseV1Structure,
  ReprepareV1,
} from '@shared/contracts/index.ts';
import { loadRubric } from '@shared/rubric/load.ts';
import { prettyJson, repoPath } from './_lib/json.ts';

const SCHEMA_DIR = 'shared/schemas/';
const ID_BASE = 'https://racketcoach.app/schemas/';

function fromZod(file: string, title: string, schema: z.ZodType, io: 'input' | 'output'): [string, JsonSchema] {
  const json = z.toJSONSchema(schema, { io, target: 'draft-2020-12' }) as JsonSchema;
  const { $schema, ...rest } = json;
  return [file, { $schema, $id: ID_BASE + file, title, ...rest }];
}

export function generateSchemas(): Map<string, JsonSchema> {
  const out = new Map<string, JsonSchema>([
    fromZod('pose.v1.json', 'pose.v1', PoseV1Structure, 'input'),
    fromZod('reprepare.v1.json', 'reprepare.v1', ReprepareV1, 'input'),
    fromZod('prepare-response.v1.json', 'prepare.v1', PrepareResponseV1Structure, 'output'),
    fromZod('clean-track.v1.json', 'clean-track.v1', CleanTrackV1Structure, 'output'),
    fromZod('coach-result.v1.json', 'coach-result.v1', CoachResultV1Structure, 'output'),
  ]);
  for (const sport of ['badminton', 'pickleball'] as const) {
    // Exactly what is sent as output_config.format.schema: no $schema/$id/title wrapper.
    out.set(`coach-output.${sport}.v1.json`, buildCoachOutputSchema(coachSchemaCatalogFromRubric(loadRubric(sport))));
  }
  return out;
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}

async function main(): Promise<number> {
  const check = Deno.args.includes('--check');
  const schemas = generateSchemas();
  let failed = false;

  for (const [file, schema] of schemas) {
    if (!file.startsWith('coach-output.')) continue;
    const problems = auditCoachOutputSchema(schema);
    if (problems.length) {
      failed = true;
      console.error(`AUDIT FAIL ${file}:\n  ${problems.join('\n  ')}`);
    } else {
      const defs = Object.keys(schema.$defs ?? {}).length;
      console.log(`audit ok   ${file} (${defs} $defs, ${JSON.stringify(schema).length} bytes)`);
    }
  }

  const stale: string[] = [];
  for (const [file, schema] of schemas) {
    const path = repoPath(SCHEMA_DIR + file);
    const text = prettyJson(schema);
    if (check) {
      if ((await readOrNull(path)) !== text) stale.push(file);
    } else {
      await Deno.writeTextFile(path, text);
      console.log(`wrote      ${SCHEMA_DIR}${file}`);
    }
  }
  if (stale.length) {
    failed = true;
    console.error(`OUT OF SYNC (run: make schemas): ${stale.join(', ')}`);
  } else if (check) {
    console.log(`in sync    ${schemas.size} schemas`);
  }
  return failed ? 1 : 0;
}

if (import.meta.main) Deno.exit(await main());
