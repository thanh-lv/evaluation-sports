/**
 * The rubric feeds the Claude output schema (DESIGN.md §7.4) and the shared fixtures: both must stay in step with it.
 * (shared/schemas sync itself is checked by tests/contracts/schemas_sync.test.ts.)
 */
import { assert, assertEquals } from '@std/assert';
import {
  auditCoachOutputSchema,
  buildCoachOutputSchema,
  coachSchemaCatalogFromRubric,
  type JsonSchema,
  NO_FAULT,
} from '@shared/contracts/index.ts';
import glossary from '@shared/rubric/glossary.json' with { type: 'json' };
import { loadFixture } from '../_helpers/fixtures.ts';
import { bundles, localizedTexts } from './_rubric.ts';

Deno.test('coach-output schemas build from the rubric, pass the audit and enumerate its ids', () => {
  for (const r of bundles()) {
    const schema = buildCoachOutputSchema(coachSchemaCatalogFromRubric(r));
    assertEquals(auditCoachOutputSchema(schema), [], r.sport);
    const defs = schema.$defs as Record<string, JsonSchema>;
    const scorable = r.checkpoints.filter((c) => c.assess !== 'N').map((c) => c.id);
    assertEquals(defs.CheckpointId.enum, scorable);
    assertEquals(defs.VisualCheckpointId.enum, r.checkpoints.filter((c) => c.assess === 'V').map((c) => c.id));
    assertEquals(defs.FaultId.enum, [...r.faults.map((f) => f.id), NO_FAULT]);
  }
});

Deno.test('fixture checkpoint, fault and drill ids exist in the rubric', async () => {
  const known = new Set(
    bundles().flatMap((r) => [
      ...r.skills.map((s) => s.id),
      ...r.checkpoints.map((c) => c.id),
      ...r.faults.map((f) => f.id),
      ...r.drills.map((d) => d.id),
    ]),
  );
  const ID = /^(bd|pb)\.[a-z0-9_]+\.[A-Za-z0-9_]+$/;
  for (const file of ['results/example_full.json', 'results/example_free.json', 'prepare/example.json']) {
    const doc = await loadFixture(file);
    const refs: string[] = [];
    const walk = (v: unknown, key = ''): void => {
      if (typeof v === 'string') {
        if (
          /^(id|checkpointId|faultId|metricKey|skill)$/.test(key) && (ID.test(v) || /^(bd|pb)\.[a-z0-9_]+$/.test(v))
        ) {
          refs.push(v);
        }
      } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
      else if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) walk(x, k); }
    };
    walk(doc);
    if (file.startsWith('results/')) assert(refs.length > 5, `${file}: expected rubric references`);
    for (const id of refs) assert(known.has(id), `${file}: ${id} is not in the rubric`);
  }
});

Deno.test('glossary rows are bilingual, unique and flagged for review', () => {
  const ids = glossary.terms.map((t) => t.id);
  assertEquals(new Set(ids).size, ids.length);
  for (const t of glossary.terms) {
    assert(t.en.trim() && t.vi.trim(), t.id);
    assertEquals(t.reviewed, false, `${t.id}: only a native coach may flip reviewed`);
  }
  assertEquals(localizedTexts(glossary).length, glossary.terms.length);
  const vi = new Map(glossary.terms.map((t) => [t.id, t.vi]));
  assertEquals(vi.get('kitchen'), 'Kitchen (vùng cấm vô lê)');
  assertEquals(vi.get('split_step'), 'Bật nhún (split step)');
  assertEquals(vi.get('follow'), 'Kết thúc động tác');
  assertEquals(vi.get('recovery'), 'Về vị trí (hồi vị)');
});
