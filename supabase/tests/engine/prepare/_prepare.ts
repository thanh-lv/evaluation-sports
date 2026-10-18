/** Helpers for prepare tests: run the engine on the synthetic fixtures and check the shared invariants. */
import { assert, assertEquals } from '@std/assert';
import {
  CleanTrackV1,
  FLAG_COASTED,
  LOCAL_FRAME_IDS,
  PoseV1,
  PrepareResponseV1,
  type QuotaPreview,
  UPLOAD_FRAME_IDS,
} from '@shared/contracts/index.ts';
import {
  prepare,
  PreparedAnalysisV1,
  type PrepareOptions,
  type PrepareSuccess,
  withQuota,
} from '@shared/engine/index.ts';
import { loadRubric } from '@shared/rubric/load.ts';
import { loadFixture } from '../../_helpers/fixtures.ts';
import type { SynthTruth } from '../../../../scripts/gen-synthetic-pose.ts';

export const TEST_USER = '5f8e2c1a-9b7d-4e3f-8a6c-2d1e0f9b8a7c';
export const TEST_QUOTA: QuotaPreview = {
  tier: 'free',
  remaining: 1,
  nextKind: 'standard',
  resetsAt: '2026-11-01T00:00:00+07:00',
};

export async function loadPose(name: string): Promise<{ pose: PoseV1; truth: SynthTruth }> {
  const pose = PoseV1.parse(await loadFixture(`pose/${name}.json`));
  const truth = await loadFixture<SynthTruth>(`pose/${name}.truth.json`);
  return { pose, truth };
}

/** prepare() that must succeed; checks every contract and the cross-document invariants. */
export function prepareOk(pose: PoseV1, opts: Partial<PrepareOptions> = {}): PrepareSuccess {
  const out = prepare(pose, { rubric: loadRubric(pose.session.sport), userId: TEST_USER, ...opts });
  if (!out.ok) throw new Error(`prepare rejected: ${out.code} ${out.message}`);
  assertInvariants(pose, out);
  return out;
}

/** The invariants of DESIGN.md §6.2 / §7.3 that every prepare must uphold. */
export function assertInvariants(pose: PoseV1, out: PrepareSuccess): void {
  const response = PrepareResponseV1.parse(withQuota(out.response, TEST_QUOTA));
  const prepared = PreparedAnalysisV1.parse(out.prepared);
  const clean = CleanTrackV1.parse(out.cleanTrack);

  // Every frame time is a sampled, non-coasted PTS of the pose payload.
  const sampled = new Map(pose.track.tUs.map((t, i) => [t, i]));
  const phaseTimes = response.strokes.flatMap((s) => Object.values(s.phases));
  for (const t of phaseTimes) assert(sampled.has(t), `phase time ${t} is not a sampled PTS`);
  for (const f of response.frameRequests) {
    const i = sampled.get(f.tUs);
    assert(i !== undefined, `${f.frameId} tUs ${f.tUs} is not a sampled PTS`);
    assert(!(pose.track.flags[i] & FLAG_COASTED), `${f.frameId} lands on a coasted frame`);
    // Crops: inside [0,1]², 4:3 or 3:4 in pixels.
    const { x, y, w, h } = f.crop;
    assert(x >= 0 && y >= 0 && x + w <= 1 + 1e-9 && y + h <= 1 + 1e-9, `${f.frameId} crop outside the frame`);
    const ratio = (w * pose.video.display.w) / (h * pose.video.display.h);
    assert(
      Math.abs(ratio - 4 / 3) / (4 / 3) < 0.01 || Math.abs(ratio - 3 / 4) / (3 / 4) < 0.01,
      `${f.frameId} aspect ${ratio}`,
    );
    const stroke = response.strokes.find((s) => s.id === f.strokeId)!;
    assert(!stroke.excluded, `${f.frameId} references excluded stroke ${f.strokeId}`);
  }
  // Frame set: F1–F5 for the best stroke, L1–L4 for the worst (if any); uploads only in frames mode.
  const best = response.strokes.find((s) => s.role === 'best');
  assert(best, 'a best stroke');
  const worst = response.strokes.find((s) => s.role === 'worst');
  const ids = response.frameRequests.map((f) => f.frameId);
  assertEquals(ids, worst ? [...UPLOAD_FRAME_IDS, ...LOCAL_FRAME_IDS] : [...UPLOAD_FRAME_IDS]);
  for (const f of response.frameRequests) {
    const isLocal = (LOCAL_FRAME_IDS as readonly string[]).includes(f.frameId);
    assertEquals(f.strokeId, isLocal ? worst!.id : best.id);
    assertEquals(f.upload, !isLocal && response.frameMode === 'frames');
  }
  // All phases of a stroke share one crop.
  for (const id of new Set(response.frameRequests.filter((f) => f.phase !== 'overview').map((f) => f.strokeId))) {
    const crops = response.frameRequests.filter((f) => f.strokeId === id && f.phase !== 'overview').map((f) => f.crop);
    for (const c of crops) assertEquals(c, crops[0]);
  }
  // Prepared state and clean track agree with the response.
  assertEquals(prepared.frameRequests, response.frameRequests);
  assertEquals(prepared.warnings, response.warnings);
  assertEquals(
    prepared.strokes.map((s) => [s.id, s.role, s.excluded]),
    response.strokes.map((s) => [s.id, s.role, s.excluded]),
  );
  assertEquals(
    clean.strokes.map((s) => [s.id, s.role, s.excluded]),
    response.strokes.map((s) => [s.id, s.role, s.excluded]),
  );
  assertEquals(clean.analysisHz, pose.video.analysisHz);
  assertEquals(response.cleanTrackPath, `${TEST_USER}/${pose.analysisId}/pose.clean.json`);
}
