import { assert, assertEquals } from '@std/assert';
import {
  expectedUploadCount,
  prepareRequestKind,
  PrepareResponseV1,
  type PrepareResponseV1 as PrepareResponse,
  ReprepareV1,
} from '@shared/contracts/index.ts';
import { clone, loadFixture } from '../_helpers/fixtures.ts';

const valid = await loadFixture<PrepareResponse>('prepare/example.json');

function rejects(mutate: (r: PrepareResponse) => void, needle: string): void {
  const r = clone(valid);
  mutate(r);
  const res = PrepareResponseV1.safeParse(r);
  assert(!res.success, `expected failure: ${needle}`);
  const msgs = res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' | ');
  assert(msgs.includes(needle), `missing "${needle}" in ${msgs}`);
}

Deno.test('prepare example fixture is valid', () => {
  const r = PrepareResponseV1.safeParse(valid);
  assert(r.success, r.success ? '' : JSON.stringify(r.error.issues));
  assertEquals(expectedUploadCount(r.data), 5);
});

Deno.test('prepare invariants', () => {
  rejects((r) => {
    r.frameRequests[5].upload = true;
  }, 'L1 must never be uploaded');
  rejects((r) => {
    r.frameMode = 'pose_only';
  }, 'pose_only mode uploads no frames');
  rejects((r) => {
    r.frameRequests[0].upload = false;
  }, 'F1 must be uploaded');
  rejects((r) => {
    r.frameRequests[0].strokeId = 99;
  }, 'unknown stroke');
  rejects((r) => {
    r.strokes[3].role = 'best';
  }, 'excluded stroke 4 has a role');
  rejects((r) => {
    r.frameRequests[1].frameId = 'F1';
  }, 'duplicate frame F1');
  rejects((r) => {
    r.frameRequests[4].phase = 'contact';
  }, 'only F5 is the overview frame');
});

Deno.test('pose_only response with no uploads is valid', () => {
  const r = clone(valid);
  r.frameMode = 'pose_only';
  for (const f of r.frameRequests) f.upload = false;
  assert(PrepareResponseV1.safeParse(r).success);
  assertEquals(expectedUploadCount(r), 0);
});

Deno.test('crop is normalized', () => {
  const r = clone(valid);
  r.frameRequests[0].crop.w = 1.2;
  assert(!PrepareResponseV1.safeParse(r).success);
});

Deno.test('reprepare.v1 parses and rejects auto view', () => {
  const body = {
    schema: 'reprepare.v1',
    analysisId: valid.analysisId,
    cameraView: 'diagonal',
    excludedStrokeIds: [3],
    handedness: 'right',
  };
  assert(ReprepareV1.safeParse(body).success);
  assert(!ReprepareV1.safeParse({ ...body, cameraView: 'auto' }).success);
  assertEquals(prepareRequestKind(body), 'reprepare.v1');
  assertEquals(prepareRequestKind({ schema: 'x' }), null);
});
