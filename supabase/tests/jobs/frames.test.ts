/**
 * Review hardening of the job's frame handling and cron isolation: only real JPEGs within the bucket limit are sent,
 * and a warm-up client that cannot be built is a failed step, not a crashed cron task.
 */
import { assert, assertEquals } from '@std/assert';
import { loadFrames, looksLikeJpeg, MAX_FRAME_BYTES, runCronTask, runOnce } from '@shared/jobs/index.ts';
import { BUCKET_INPUTS, framePath } from '@shared/storage.ts';
import { captureLogger } from '@shared/testing/index.ts';
import { createBackend } from './_backend.ts';
import { jobFixture, JPEG, UID } from './_jobs.ts';

const AID = '0a0a0a0a-0000-4000-8000-000000000001';

Deno.test('loadFrames: non-JPEG and oversized objects are skipped', async () => {
  const b = createBackend();
  const big = new Uint8Array(MAX_FRAME_BYTES + 1);
  big.set(JPEG.subarray(0, 4));
  b.memory.put(BUCKET_INPUTS, framePath(UID, AID, 'F1'), JPEG, 'image/jpeg');
  b.memory.put(BUCKET_INPUTS, framePath(UID, AID, 'F2'), new TextEncoder().encode('<svg/>'), 'image/jpeg');
  b.memory.put(BUCKET_INPUTS, framePath(UID, AID, 'F3'), big, 'image/jpeg');
  b.memory.put(BUCKET_INPUTS, framePath(UID, AID, 'F4'), new Uint8Array(0), 'image/jpeg');
  const frames = await loadFrames(b.storage, UID, AID, ['F1', 'F2', 'F3', 'F4', 'F5']);
  assertEquals(frames.map((f) => f.frameId), ['F1']);
  assert(looksLikeJpeg(JPEG));
  assert(!looksLikeJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47])));
});

Deno.test('runOnce: frames that are all non-JPEG fail the job like missing frames (refund, no model call)', async () => {
  const f = await jobFixture({ frames: false });
  for (const r of f.prepared.frameRequests.filter((x) => x.upload)) {
    f.backend.memory.put(
      BUCKET_INPUTS,
      framePath(UID, f.id, r.frameId),
      new TextEncoder().encode('GIF89a'),
      'image/jpeg',
    );
  }
  const r = await runOnce(f.id, f.deps);
  assertEquals(r, { status: 'failed', attempt: 1, code: 'internal' });
  assertEquals(f.client.calls.length, 0);
  assertEquals(f.backend.ledger.get(f.id)!.state, 'refunded');
});

Deno.test('cron: a warm-up client that throws while being built is a failed step, the task still resolves', async () => {
  const b = createBackend();
  const { log, lines } = captureLogger();
  const out = await runCronTask('warm', {
    db: b.db,
    storage: b.storage,
    log,
    claudeMode: 'live',
    warmClient: () => {
      throw new Error('cannot build client');
    },
    syncNotifications: null,
  });
  assertEquals(out.warm, { ok: false, error: 'cannot build client' });
  assert(lines.some((l) => l.entry.msg === 'cron step failed' && l.entry.step === 'warm'));
});
