/**
 * `_shared/storage.ts` over the in-memory bucket and against the local stack's Storage API (throwaway top-level
 * folder `zz-infra-test-<uuid>`, removed at the end).
 */
import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import {
  BUCKET_DERIVED,
  BUCKET_INPUTS,
  type BucketsApi,
  createStorageService,
  framePath,
  normalizeStoragePath,
  poseCleanPath,
  poseRawPath,
} from '@shared/storage.ts';
import { createServiceSupabase } from '@shared/db.ts';
import { HttpError } from '@shared/errors.ts';
import { createFakeStorage } from '@shared/testing/index.ts';
import { getLocalStack } from '@shared/testing/local_stack.ts';

Deno.test('path helpers follow DESIGN §6.6', () => {
  assertEquals(framePath('u', 'a', 'F1'), 'u/a/frames/F1.jpg');
  assertEquals(poseRawPath('u', 'a'), 'u/a/pose.raw.json');
  assertEquals(poseCleanPath('u', 'a'), 'u/a/pose.clean.json');
  assertEquals(normalizeStoragePath('/u/a/'), 'u/a');
  assertEquals(normalizeStoragePath('', true), '');
  for (const bad of ['', 'u//a', 'u/../v', './u']) assertThrows(() => normalizeStoragePath(bad));
});

Deno.test('fake: upload/download/json/exists/signedUrl', async () => {
  const { storage, memory } = createFakeStorage();
  await storage.uploadJson(BUCKET_DERIVED, 'u/a/pose.raw.json', { a: 1 });
  assertEquals(memory.bucket(BUCKET_DERIVED).get('u/a/pose.raw.json')?.contentType, 'application/json');
  assertEquals(await storage.downloadJson(BUCKET_DERIVED, 'u/a/pose.raw.json'), { a: 1 });
  assertEquals(await storage.downloadText(BUCKET_DERIVED, '/u/a/pose.raw.json'), '{"a":1}');
  assertEquals(await storage.download(BUCKET_DERIVED, 'u/a/missing.json'), null);
  assertEquals(await storage.exists(BUCKET_DERIVED, 'u/a/pose.raw.json'), true);
  assertEquals(await storage.exists(BUCKET_DERIVED, 'u/a/pose.raw'), false);
  assertEquals(await storage.exists(BUCKET_DERIVED, 'u/a'), false, 'a folder is not an object');
  // upload without upsert refuses to overwrite; uploadJson upserts
  await assertRejects(
    () => storage.upload(BUCKET_DERIVED, 'u/a/pose.raw.json', '{}', { contentType: 'application/json' }),
    HttpError,
  );
  await storage.uploadJson(BUCKET_DERIVED, 'u/a/pose.raw.json', { a: 2 });
  assertEquals(await storage.downloadJson(BUCKET_DERIVED, 'u/a/pose.raw.json'), { a: 2 });
  assert((await storage.signedUrl(BUCKET_DERIVED, 'u/a/pose.raw.json', 60)).includes('expires=60'));
  const err = await assertRejects(() => storage.signedUrl(BUCKET_DERIVED, 'u/a/nope.json', 60), HttpError);
  assertEquals(err.code, 'not_found');
});

Deno.test('fake: list, listRecursive, remove in batches ≤ 1000, removePrefix', async () => {
  const { storage, memory } = createFakeStorage({ listPageSize: 7 });
  for (let i = 0; i < 2500; i++) memory.put(BUCKET_INPUTS, `u1/a${i % 3}/frames/F${i}.jpg`, 'x', 'image/jpeg');
  memory.put(BUCKET_INPUTS, 'u1/top.jpg', 'x', 'image/jpeg');
  memory.put(BUCKET_INPUTS, 'u2/a/frames/F1.jpg', 'x', 'image/jpeg');

  const children = await storage.list(BUCKET_INPUTS, 'u1');
  assertEquals(children.map((c) => [c.name, c.isFolder]), [['a0', true], ['a1', true], ['a2', true], [
    'top.jpg',
    false,
  ]]);
  const all = await storage.listRecursive(BUCKET_INPUTS, 'u1');
  assertEquals(all.length, 2501);
  assert(all.every((p) => p.startsWith('u1/')));

  assertEquals(await storage.removePrefix(BUCKET_INPUTS, 'u1'), 2501);
  assertEquals(memory.removeCalls.map((c) => c.count), [1000, 1000, 501]);
  assertEquals(memory.paths(BUCKET_INPUTS), ['u2/a/frames/F1.jpg']);
  assertEquals(await storage.removePrefix(BUCKET_INPUTS, 'u1'), 0, 'idempotent');
  assertEquals(await storage.remove(BUCKET_INPUTS, []), 0);
  await assertRejects(() => storage.removePrefix(BUCKET_INPUTS, ''));
});

Deno.test('fake: move and movePrefix (account merge), overwrite option', async () => {
  const { storage, memory } = createFakeStorage();
  memory.put(BUCKET_DERIVED, 'anon/a1/pose.raw.json', '1');
  memory.put(BUCKET_DERIVED, 'anon/a1/pose.clean.json', '2');
  memory.put(BUCKET_DERIVED, 'anon/a2/pose.raw.json', '3');
  memory.put(BUCKET_DERIVED, 'perm/a2/pose.raw.json', 'old');
  memory.put(BUCKET_DERIVED, 'anonymous/x.json', 'not under anon/');

  // without overwrite the conflicting a2 fails (a1 is moved: moves are per object, not atomic)
  await assertRejects(() => storage.movePrefix(BUCKET_DERIVED, 'anon', 'perm'), HttpError);
  // a retry with overwrite moves what is left
  assertEquals(await storage.movePrefix(BUCKET_DERIVED, 'anon', 'perm', { overwrite: true }), 1);
  assertEquals(memory.paths(BUCKET_DERIVED), [
    'anonymous/x.json',
    'perm/a1/pose.clean.json',
    'perm/a1/pose.raw.json',
    'perm/a2/pose.raw.json',
  ]);
  assertEquals(await storage.downloadText(BUCKET_DERIVED, 'perm/a2/pose.raw.json'), '3');
  assertEquals(await storage.movePrefix(BUCKET_DERIVED, 'perm', 'perm'), 0);
  await assertRejects(() => storage.movePrefix(BUCKET_DERIVED, 'perm', 'perm/sub'), Error, 'into itself');
  await assertRejects(() => storage.move(BUCKET_DERIVED, 'nope.json', 'x.json'), HttpError);
});

// ---------------------------------------------------------------------------------------------------------------
// Local stack

const stack = await getLocalStack();

Deno.test({
  name: 'local stack: storage helpers against the real Storage API',
  ignore: !stack,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const client = createServiceSupabase({ supabaseUrl: stack!.url, serviceKey: stack!.serviceKey });
    // count remove calls to check batching against the real API
    const removeSizes: number[] = [];
    const api: BucketsApi = {
      from(bucket) {
        const real = client.storage.from(bucket);
        return {
          list: (p, o) => real.list(p, o as never),
          remove: (paths) => {
            removeSizes.push(paths.length);
            return real.remove(paths);
          },
          move: (a, b) => real.move(a, b),
          upload: (p, body, o) => real.upload(p, body, o),
          download: (p) => real.download(p),
          createSignedUrl: (p, e) => real.createSignedUrl(p, e),
        };
      },
    };
    const storage = createStorageService(api, { removeBatchSize: 2, listPageSize: 2 });
    const root = `zz-infra-test-${crypto.randomUUID()}`;
    try {
      // JSON in analysis-derived, JPEG in analysis-inputs (bucket MIME limits apply)
      await storage.uploadJson(BUCKET_DERIVED, `${root}/a1/pose.raw.json`, { schema: 'pose.v1', n: 1 });
      await storage.uploadJson(BUCKET_DERIVED, `${root}/a1/pose.clean.json`, { n: 2 });
      await storage.uploadJson(BUCKET_DERIVED, `${root}/a2/pose.raw.json`, { n: 3 });
      const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);
      await storage.upload(BUCKET_INPUTS, `${root}/a1/frames/F1.jpg`, jpeg, { contentType: 'image/jpeg' });

      assertEquals(await storage.downloadJson(BUCKET_DERIVED, `${root}/a1/pose.raw.json`), { schema: 'pose.v1', n: 1 });
      assertEquals(await storage.download(BUCKET_INPUTS, `${root}/a1/frames/F1.jpg`), jpeg);
      assertEquals(await storage.download(BUCKET_DERIVED, `${root}/a1/missing.json`), null);
      assertEquals(await storage.exists(BUCKET_DERIVED, `${root}/a1/pose.raw.json`), true);
      assertEquals(await storage.exists(BUCKET_DERIVED, `${root}/a1/pose.raw`), false);

      // a duplicate upload without upsert fails; uploadJson upserts
      await assertRejects(
        () => storage.upload(BUCKET_DERIVED, `${root}/a2/pose.raw.json`, '{}', { contentType: 'application/json' }),
        HttpError,
      );
      await storage.uploadJson(BUCKET_DERIVED, `${root}/a2/pose.raw.json`, { n: 4 });
      assertEquals(await storage.downloadJson(BUCKET_DERIVED, `${root}/a2/pose.raw.json`), { n: 4 });

      // signed URL serves the object
      const url = await storage.signedUrl(BUCKET_DERIVED, `${root}/a1/pose.clean.json`, 60);
      const res = await fetch(url);
      assertEquals(await res.json(), { n: 2 });
      const missing = await assertRejects(() => storage.signedUrl(BUCKET_DERIVED, `${root}/zz.json`, 60), HttpError);
      assertEquals(missing.code, 'not_found');

      // a missing bucket is a server error, not "object not found"
      const noBucket = await assertRejects(() => storage.download('no-such-bucket', `${root}/x.json`), HttpError);
      assertEquals(noBucket.code, 'internal');

      // recursive listing with paging (page size 2)
      assertEquals((await storage.list(BUCKET_DERIVED, root)).map((e) => [e.name, e.isFolder]), [['a1', true], [
        'a2',
        true,
      ]]);
      assertEquals(await storage.listRecursive(BUCKET_DERIVED, root), [
        `${root}/a1/pose.clean.json`,
        `${root}/a1/pose.raw.json`,
        `${root}/a2/pose.raw.json`,
      ]);

      // account-merge style prefix move
      const to = `${root}/merged`;
      assertEquals(await storage.movePrefix(BUCKET_DERIVED, `${root}/a1`, to), 2);
      assertEquals(await storage.listRecursive(BUCKET_DERIVED, `${root}/a1`), []);
      assertEquals(await storage.downloadJson(BUCKET_DERIVED, `${to}/pose.clean.json`), { n: 2 });
      // a move onto an existing object fails unless overwrite is set
      await storage.uploadJson(BUCKET_DERIVED, `${root}/a2/pose.clean.json`, { n: 5 });
      await assertRejects(() => storage.move(BUCKET_DERIVED, `${root}/a2/pose.clean.json`, `${to}/pose.clean.json`));
      await storage.move(BUCKET_DERIVED, `${root}/a2/pose.clean.json`, `${to}/pose.clean.json`, { overwrite: true });
      assertEquals(await storage.downloadJson(BUCKET_DERIVED, `${to}/pose.clean.json`), { n: 5 });

      // recursive delete in batches of 2: 3 objects left in derived → [2, 1]
      removeSizes.length = 0;
      assertEquals(await storage.removePrefix(BUCKET_DERIVED, root), 3);
      assertEquals(removeSizes, [2, 1]);
      assertEquals(await storage.listRecursive(BUCKET_DERIVED, root), []);
      assertEquals(await storage.removePrefix(BUCKET_DERIVED, root), 0);
    } finally {
      const cleanup = createStorageService(client.storage);
      await cleanup.removePrefix(BUCKET_DERIVED, root).catch(() => 0);
      await cleanup.removePrefix(BUCKET_INPUTS, root).catch(() => 0);
    }
    assertEquals(await createStorageService(client.storage).listRecursive(BUCKET_INPUTS, root), []);
  },
});
