/** Helpers for the Claude module tests: prepared fixtures, request inputs, snapshots. */
import { assertEquals } from '@std/assert';
import { type FrameMode, type Language, PoseV1, type UploadFrameId } from '@shared/contracts/index.ts';
import { prepare, type PreparedAnalysisV1 } from '@shared/engine/index.ts';
import { loadRubric } from '@shared/rubric/load.ts';
import type { RubricBundle } from '@shared/rubric/types.ts';
import {
  type CoachRequestInput,
  DEFAULT_MODEL_ROUTES,
  type FrameImage,
  type MockSource,
  type PostprocessContext,
} from '@shared/claude/index.ts';
import type { AnalysisKind } from '@shared/contracts/common.ts';
import { loadFixture } from '../_helpers/fixtures.ts';

export const TEST_USER = '5f8e2c1a-9b7d-4e3f-8a6c-2d1e0f9b8a7c';
export const CREATED_AT = '2026-10-20T08:00:00Z';

/** Synthetic pose fixtures that prepare successfully (scripts/gen-synthetic-pose.ts). */
export const SYNTHETIC = [
  'synthetic_bd_clear_fh_60',
  'synthetic_bd_smash_30',
  'synthetic_bd_serve_low_60',
  'synthetic_bd_clear_fh_30_mirrored',
  'synthetic_pb_serve_30',
  'synthetic_pb_dink_60',
  'synthetic_pb_drop3_30',
  'synthetic_pb_dink_30_left',
] as const;

export interface Prepared {
  prepared: PreparedAnalysisV1;
  rubric: RubricBundle;
}

const cache = new Map<string, Prepared>();

/** prepare() on a synthetic pose fixture (memoised; callers must not mutate the result — use structuredClone). */
export async function preparedFixture(name: string, frameMode?: FrameMode): Promise<Prepared> {
  const key = `${name}:${frameMode ?? ''}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const pose = PoseV1.parse(await loadFixture(`pose/${name}.json`));
  const rubric = loadRubric(pose.session.sport);
  const out = prepare(pose, { rubric, userId: TEST_USER, frameMode });
  if (!out.ok) throw new Error(`${name}: prepare rejected ${out.code}`);
  const p = { prepared: out.prepared, rubric };
  cache.set(key, p);
  return p;
}

/** Placeholder frames for every uploaded frame request (the mock never decodes them). */
export function framesFor(p: PreparedAnalysisV1): FrameImage[] {
  return p.frameRequests.filter((f) => f.upload).map((f) => ({
    frameId: f.frameId as UploadFrameId,
    jpegBase64: `/9j/${f.frameId}`,
  }));
}

export function requestInput(
  { prepared, rubric }: Prepared,
  language: Language,
  kind: AnalysisKind = 'standard',
): CoachRequestInput {
  return { prepared, rubric, language, route: DEFAULT_MODEL_ROUTES[kind], frames: framesFor(prepared) };
}

/** Postprocess context for a prepared fixture with every uploaded frame sent (none in pose_only). */
export function ppContext({ prepared, rubric }: Prepared, language: Language): PostprocessContext & MockSource {
  const sentFrameIds = prepared.frameMode === 'frames' ? framesFor(prepared).map((f) => f.frameId) : [];
  return { prepared, rubric, language, sentFrameIds };
}

const SNAPSHOTS = new URL('./snapshots/', import.meta.url);

/** Compares `actual` with snapshots/<name>; `UPDATE_SNAPSHOTS=1` rewrites the file instead. */
export async function assertSnapshot(name: string, actual: string): Promise<void> {
  const url = new URL(name, SNAPSHOTS);
  if (Deno.env.get('UPDATE_SNAPSHOTS') === '1') {
    await Deno.mkdir(SNAPSHOTS, { recursive: true });
    await Deno.writeTextFile(url, actual);
    return;
  }
  let expected: string;
  try {
    expected = await Deno.readTextFile(url);
  } catch {
    throw new Error(`snapshot ${name} missing: run the test with UPDATE_SNAPSHOTS=1`);
  }
  assertEquals(actual, expected, `snapshot ${name} changed (UPDATE_SNAPSHOTS=1 to accept)`);
}
