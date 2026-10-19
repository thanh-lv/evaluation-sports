/**
 * In-memory Storage that behaves like the Storage API as seen through storage-js 2.117.2 (error shapes copied from
 * the local stack: `Object not found` = statusCode "404" / NoSuchKey, existing destination = "409").
 */
import type { BucketApi, BucketsApi, ListEntryLike, StorageErrorLike } from '../storage.ts';
import { createStorageService, type StorageService, type StorageServiceOptions } from '../storage.ts';

export interface StoredObject {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
}

const notFound: StorageErrorLike = {
  name: 'StorageApiError',
  message: 'Object not found',
  status: 400,
  statusCode: '404',
  code: 'NoSuchKey',
};
const exists = (code: string): StorageErrorLike => ({
  name: 'StorageApiError',
  message: 'The resource already exists',
  status: 400,
  statusCode: '409',
  code,
});

export class MemoryStorage implements BucketsApi {
  readonly buckets = new Map<string, Map<string, StoredObject>>();
  /** Sizes of every `remove` call, per bucket (to check batching). */
  readonly removeCalls: { bucket: string; count: number }[] = [];
  readonly moveCalls: { bucket: string; from: string; to: string }[] = [];

  bucket(name: string): Map<string, StoredObject> {
    let b = this.buckets.get(name);
    if (!b) {
      b = new Map();
      this.buckets.set(name, b);
    }
    return b;
  }

  /** Seeds an object directly. */
  put(bucket: string, path: string, body: string | Uint8Array = '{}', contentType = 'application/json'): void {
    this.bucket(bucket).set(path, {
      bytes: typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body),
      contentType,
    });
  }

  paths(bucket: string): string[] {
    return [...this.bucket(bucket).keys()].sort();
  }

  from(bucketName: string): BucketApi {
    const objects = this.bucket(bucketName);
    const { removeCalls, moveCalls } = this;
    return {
      list(path = '', options = {}) {
        const folder = path.replace(/^\/+|\/+$/g, '');
        const prefix = folder ? `${folder}/` : '';
        const children = new Map<string, ListEntryLike>();
        for (const key of objects.keys()) {
          if (!key.startsWith(prefix)) continue;
          const rest = key.slice(prefix.length);
          const slash = rest.indexOf('/');
          const name = slash < 0 ? rest : rest.slice(0, slash);
          if (options.search && !name.startsWith(options.search)) continue;
          if (!children.has(name) || slash >= 0) {
            children.set(
              name,
              slash < 0 ? { name, id: `id-${key}`, metadata: {} } : { name, id: null, metadata: null },
            );
          }
        }
        const sorted = [...children.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        const offset = options.offset ?? 0;
        const limit = options.limit ?? 100;
        return Promise.resolve({ data: sorted.slice(offset, offset + limit), error: null });
      },
      remove(paths) {
        removeCalls.push({ bucket: bucketName, count: paths.length });
        const removed: unknown[] = [];
        for (const p of paths) if (objects.delete(p)) removed.push({ name: p });
        return Promise.resolve({ data: removed, error: null });
      },
      move(from, to) {
        moveCalls.push({ bucket: bucketName, from, to });
        const obj = objects.get(from);
        if (!obj) return Promise.resolve({ data: null, error: notFound });
        if (objects.has(to)) return Promise.resolve({ data: null, error: exists('ResourceAlreadyExists') });
        objects.delete(from);
        objects.set(to, obj);
        return Promise.resolve({ data: { message: 'Successfully moved' }, error: null });
      },
      async upload(path, body, options = {}) {
        if (objects.has(path) && !options.upsert) return { data: null, error: exists('KeyAlreadyExists') };
        const bytes = typeof body === 'string'
          ? new TextEncoder().encode(body)
          : body instanceof Blob
          ? new Uint8Array(await body.arrayBuffer())
          : new Uint8Array(body);
        objects.set(path, { bytes, contentType: options.contentType ?? 'text/plain;charset=UTF-8' });
        return { data: { path }, error: null };
      },
      download(path) {
        const obj = objects.get(path);
        if (!obj) return Promise.resolve({ data: null, error: notFound });
        return Promise.resolve({ data: new Blob([obj.bytes], { type: obj.contentType }), error: null });
      },
      createSignedUrl(path, expiresIn) {
        if (!objects.has(path)) return Promise.resolve({ data: null, error: notFound });
        const url = `http://storage.test/object/sign/${bucketName}/${path}?token=fake&expires=${expiresIn}`;
        return Promise.resolve({ data: { signedUrl: url }, error: null });
      },
    };
  }
}

/** A StorageService over a fresh MemoryStorage (returned too, for seeding and assertions). */
export function createFakeStorage(
  options: StorageServiceOptions = {},
): { storage: StorageService; memory: MemoryStorage } {
  const memory = new MemoryStorage();
  return { storage: createStorageService(memory, options), memory };
}
