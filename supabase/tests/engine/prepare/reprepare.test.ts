/** reprepare (DESIGN.md §7.2): excluded strokes, view changes and handedness on the stored raw pose. */
import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { ReprepareV1 } from '@shared/contracts/index.ts';
import { reprepare } from '@shared/engine/index.ts';
import { loadRubric } from '@shared/rubric/load.ts';
import { assertInvariants, loadPose, prepareOk, TEST_USER } from './_prepare.ts';

async function base() {
  const { pose } = await loadPose('synthetic_bd_clear_fh_60');
  return { pose, first: prepareOk(pose), rubric: loadRubric('badminton') };
}

function req(analysisId: string, over: Partial<ReprepareV1> = {}): ReprepareV1 {
  return ReprepareV1.parse({
    schema: 'reprepare.v1',
    analysisId,
    cameraView: 'side',
    excludedStrokeIds: [],
    handedness: 'right',
    ...over,
  });
}

Deno.test('reprepare with the same choices reproduces prepare (stable stroke ids)', async () => {
  const { pose, first, rubric } = await base();
  const again = reprepare(pose, req(pose.analysisId), { rubric, userId: TEST_USER });
  assert(again.ok);
  // Only the view-confirmation bookkeeping may differ (the user has now confirmed "side").
  assertEquals(again.response.strokes, first.response.strokes);
  assertEquals(again.response.frameRequests, first.response.frameRequests);
  assertEquals(again.prepared.checkpointTable, first.prepared.checkpointTable);
});

Deno.test('excluding the best stroke: it stays listed, loses its role and frames, scores change', async () => {
  const { pose, first, rubric } = await base();
  const best = first.response.strokes.find((s) => s.role === 'best')!;
  const out = reprepare(pose, req(pose.analysisId, { excludedStrokeIds: [best.id, 99] }), {
    rubric,
    userId: TEST_USER,
  });
  assert(out.ok);
  assertInvariants(pose, out);
  assertEquals(out.response.strokes.map((s) => s.id), first.response.strokes.map((s) => s.id));
  const ex = out.response.strokes.find((s) => s.id === best.id)!;
  assertEquals([ex.excluded, ex.role], [true, null]);
  const newBest = out.response.strokes.find((s) => s.role === 'best')!;
  assertNotEquals(newBest.id, best.id);
  assert(out.response.frameRequests.every((f) => f.strokeId !== best.id));
  // The excluded stroke no longer feeds the aggregates.
  for (const row of out.prepared.checkpointTable) {
    const ps = row.perStroke.find((p) => p.strokeId === best.id);
    if (ps) assertEquals(ps.used, false);
  }
});

Deno.test('excluding down to one stroke: best only (5 frames) and few_strokes', async () => {
  const { pose, first, rubric } = await base();
  const ids = first.response.strokes.map((s) => s.id);
  const out = reprepare(pose, req(pose.analysisId, { excludedStrokeIds: ids.slice(1) }), { rubric });
  assert(out.ok);
  assertEquals(out.response.strokes.filter((s) => s.role !== null).map((s) => [s.id, s.role]), [[ids[0], 'best']]);
  assertEquals(out.response.frameRequests.map((f) => f.frameId), ['F1', 'F2', 'F3', 'F4', 'F5']);
  assert(out.response.warnings.includes('few_strokes'));
});

Deno.test('excluding every stroke is a no_strokes_detected rejection', async () => {
  const { pose, first, rubric } = await base();
  const out = reprepare(pose, req(pose.analysisId, { excludedStrokeIds: first.response.strokes.map((s) => s.id) }), {
    rubric,
  });
  assertEquals(out.ok ? null : out.code, 'no_strokes_detected');
});

Deno.test('view change to behind: view factors switch, the guess now mismatches, no re-confirmation', async () => {
  const { pose, first, rubric } = await base();
  const out = reprepare(pose, req(pose.analysisId, { cameraView: 'behind' }), { rubric, userId: TEST_USER });
  assert(out.ok);
  assertInvariants(pose, out);
  assertEquals([out.prepared.view, out.prepared.viewSource], ['behind', 'user']);
  // Strokes do not depend on the view.
  assertEquals(out.response.strokes.map((s) => s.tContactUs), first.response.strokes.map((s) => s.tContactUs));
  const status = (p: typeof first.prepared, id: string) => p.checkpointTable.find((r) => r.id === id)!.status;
  assertEquals([status(first.prepared, 'bd.ready.R1'), status(out.prepared, 'bd.ready.R1')], [
    'view_excluded',
    'measured',
  ]);
  assertEquals([status(first.prepared, 'bd.clear_fh.C6'), status(out.prepared, 'bd.clear_fh.C6')], [
    'measured',
    'view_excluded',
  ]);
  assert(out.response.warnings.includes('view_mismatch'));
  assert(!out.response.warnings.includes('view_low_confidence'));
  assert(out.response.warnings.includes('view_not_recommended'));
  const diag = reprepare(pose, req(pose.analysisId, { cameraView: 'diagonal' }), { rubric });
  assert(diag.ok && !diag.response.warnings.includes('view_not_recommended'), 'D is recommended for the clear');
});

Deno.test("cameraView auto scores with the guess; an explicit view is the user's", async () => {
  const { pose, rubric } = await base();
  const auto = prepareOk({ ...pose, session: { ...pose.session, cameraView: 'auto' } }, { rubric });
  assertEquals([auto.prepared.view, auto.prepared.viewSource], [auto.response.viewGuess.view, 'guess']);
  const explicit = prepareOk(pose, { rubric, view: 'diagonal' });
  assertEquals([explicit.prepared.view, explicit.prepared.viewSource], ['diagonal', 'user']);
});
