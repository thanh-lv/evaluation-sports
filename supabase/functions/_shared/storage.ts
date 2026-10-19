/**
 * Storage helpers (DESIGN §6.6): signed URLs, download/upload, recursive listing, batched removal (≤ 1000 per call)
 * and prefix moves (account merge).
 *
 * `createStorageService(api)` takes anything shaped like supabase-js `client.storage` (`BucketsApi`), so tests run
 * the same logic over the in-memory bucket from `_shared/testing`.
 */
import { httpError } from './errors.ts';

export const BUCKET_INPUTS = 'analysis-inputs';
export const BUCKET_DERIVED = 'analysis-derived';
export const BUCKETS = [BUCKET_INPUTS, BUCKET_DERIVED] as const;

/** `{uid}/{aid}/frames/F1.jpg` in `analysis-inputs`. */
export function framePath(userId: string, analysisId: string, frameId: string): string {
  return `${userId}/${analysisId}/frames/${frameId}.jpg`;
}
export function framesPrefix(userId: string, analysisId: string): string {
  return `${userId}/${analysisId}/frames`;
}
/** `{uid}/{aid}/pose.raw.json` in `analysis-derived` (the clean track path is the engine's `cleanTrackPath`). */
export function poseRawPath(userId: string, analysisId: string): string {
  return `${userId}/${analysisId}/pose.raw.json`;
}
export function poseCleanPath(userId: string, analysisId: string): string {
  return `${userId}/${analysisId}/pose.clean.json`;
}

// ---------------------------------------------------------------------------------------------------------------
// Low-level API (subset of supabase-js storage-js 2.117.2 `StorageFileApi`)

export interface StorageErrorLike {
  message: string;
  name?: string;
  status?: number;
  statusCode?: string;
  code?: string;
}

export interface ListEntryLike {
  name: string;
  /** null for folders. */
  id: string | null;
  metadata?: Record<string, unknown> | null;
}

type Result<T> = { data: T; error: null } | { data: null; error: StorageErrorLike };

export interface BucketApi {
  list(
    path?: string,
    options?: { limit?: number; offset?: number; sortBy?: { column?: string; order?: string }; search?: string },
  ): Promise<Result<ListEntryLike[]>>;
  remove(paths: string[]): Promise<Result<unknown[]>>;
  move(fromPath: string, toPath: string): Promise<Result<unknown>>;
  upload(
    path: string,
    body: Uint8Array | Blob | string,
    options?: { contentType?: string; upsert?: boolean; cacheControl?: string },
  ): Promise<Result<unknown>>;
  download(path: string): PromiseLike<Result<Blob>>;
  createSignedUrl(path: string, expiresIn: number): Promise<Result<{ signedUrl: string }>>;
}

export interface BucketsApi {
  from(bucket: string): BucketApi;
}

// ---------------------------------------------------------------------------------------------------------------
// Service

export interface StorageEntry {
  name: string;
  /** Full object path (or folder path) inside the bucket. */
  path: string;
  isFolder: boolean;
}

export interface UploadOptions {
  contentType: string;
  upsert?: boolean;
  cacheControl?: string;
}

export interface MoveOptions {
  /** Replace an object already at the destination (default false: such a move fails). */
  overwrite?: boolean;
}

export interface StorageService {
  signedUrl(bucket: string, path: string, expiresInSec: number): Promise<string>;
  /** null when the object does not exist. */
  download(bucket: string, path: string): Promise<Uint8Array<ArrayBuffer> | null>;
  downloadText(bucket: string, path: string): Promise<string | null>;
  downloadJson<T = unknown>(bucket: string, path: string): Promise<T | null>;
  upload(bucket: string, path: string, body: Uint8Array | Blob | string, options: UploadOptions): Promise<void>;
  /** JSON upload (`application/json`, upsert by default). */
  uploadJson(bucket: string, path: string, value: unknown, options?: { upsert?: boolean }): Promise<void>;
  exists(bucket: string, path: string): Promise<boolean>;
  /** Direct children of a folder (objects and sub-folders). */
  list(bucket: string, prefix: string): Promise<StorageEntry[]>;
  /** Every object path under `prefix`, depth-first. */
  listRecursive(bucket: string, prefix: string): Promise<string[]>;
  /** Removes objects in batches of at most `removeBatchSize`; returns how many were removed. */
  remove(bucket: string, paths: readonly string[]): Promise<number>;
  /** Recursively removes everything under `prefix` (e.g. `{uid}`); returns the count. Idempotent. */
  removePrefix(bucket: string, prefix: string): Promise<number>;
  move(bucket: string, fromPath: string, toPath: string, options?: MoveOptions): Promise<void>;
  /** Moves every object under `fromPrefix` to the same relative path under `toPrefix`; returns the count. */
  movePrefix(bucket: string, fromPrefix: string, toPrefix: string, options?: MoveOptions): Promise<number>;
}

export interface StorageServiceOptions {
  /** Objects per `remove` call (Storage API limit 1000). */
  removeBatchSize?: number;
  /** Entries per `list` page. */
  listPageSize?: number;
  /** Parallel moves in `movePrefix`. */
  moveConcurrency?: number;
  /** Folder depth guard for the recursive walk. */
  maxDepth?: number;
}

export const MAX_REMOVE_BATCH = 1000;

/** Strips leading/trailing slashes and refuses `..`, empty segments and absolute paths. */
export function normalizeStoragePath(path: string, allowEmpty = false): string {
  const trimmed = path.replace(/^\/+|\/+$/g, '');
  if (trimmed === '') {
    if (allowEmpty) return '';
    throw new Error('empty storage path');
  }
  const segments = trimmed.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) throw new Error(`invalid storage path: ${path}`);
  return trimmed;
}

/**
 * Missing object (Storage API: HTTP 400, `statusCode "404"`, `code "NoSuchKey"`, "Object not found"). A missing
 * bucket (`NoSuchBucket`, also statusCode 404) is a configuration error and is NOT treated as not-found.
 */
function isNotFound(err: StorageErrorLike): boolean {
  if (err.code !== undefined) return err.code === 'NoSuchKey';
  return (err.statusCode === '404' || err.status === 404) && !/bucket/i.test(err.message);
}

/** Destination exists (`statusCode "409"`, `ResourceAlreadyExists` on move, `KeyAlreadyExists` on upload). */
function isAlreadyExists(err: StorageErrorLike): boolean {
  return err.statusCode === '409' || err.status === 409 || err.code === 'ResourceAlreadyExists' ||
    err.code === 'KeyAlreadyExists';
}

function fail(op: string, err: StorageErrorLike): never {
  throw httpError('internal', `storage ${op} failed`, { cause: err });
}

async function pool<T>(items: readonly T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, worker));
}

export function createStorageService(api: BucketsApi, options: StorageServiceOptions = {}): StorageService {
  const removeBatchSize = Math.min(options.removeBatchSize ?? MAX_REMOVE_BATCH, MAX_REMOVE_BATCH);
  const pageSize = options.listPageSize ?? 1000;
  const moveConcurrency = options.moveConcurrency ?? 8;
  const maxDepth = options.maxDepth ?? 12;

  const listAll = async (bucket: string, prefix: string): Promise<StorageEntry[]> => {
    const folder = normalizeStoragePath(prefix, true);
    const out: StorageEntry[] = [];
    for (let offset = 0;; offset += pageSize) {
      const { data, error } = await api.from(bucket).list(folder, {
        limit: pageSize,
        offset,
        sortBy: { column: 'name', order: 'asc' },
      });
      if (error) fail('list', error);
      for (const e of data) {
        out.push({ name: e.name, path: folder ? `${folder}/${e.name}` : e.name, isFolder: e.id === null });
      }
      if (data.length < pageSize) break;
    }
    return out;
  };

  const listRecursive = async (bucket: string, prefix: string): Promise<string[]> => {
    const files: string[] = [];
    const walk = async (folder: string, depth: number): Promise<void> => {
      if (depth > maxDepth) throw new Error(`storage walk deeper than ${maxDepth} under ${prefix}`);
      for (const entry of await listAll(bucket, folder)) {
        if (entry.isFolder) await walk(entry.path, depth + 1);
        else files.push(entry.path);
      }
    };
    await walk(normalizeStoragePath(prefix, true), 0);
    return files;
  };

  const remove = async (bucket: string, paths: readonly string[]): Promise<number> => {
    let removed = 0;
    const clean = paths.map((p) => normalizeStoragePath(p));
    for (let i = 0; i < clean.length; i += removeBatchSize) {
      const { data, error } = await api.from(bucket).remove(clean.slice(i, i + removeBatchSize));
      if (error) fail('remove', error);
      removed += data.length;
    }
    return removed;
  };

  const move = async (bucket: string, fromPath: string, toPath: string, opts: MoveOptions = {}): Promise<void> => {
    const from = normalizeStoragePath(fromPath);
    const to = normalizeStoragePath(toPath);
    const first = await api.from(bucket).move(from, to);
    if (!first.error) return;
    if (opts.overwrite && isAlreadyExists(first.error)) {
      const rm = await api.from(bucket).remove([to]);
      if (rm.error) fail('move', rm.error);
      const second = await api.from(bucket).move(from, to);
      if (second.error) fail('move', second.error);
      return;
    }
    fail('move', first.error);
  };

  const download = async (bucket: string, path: string): Promise<Uint8Array<ArrayBuffer> | null> => {
    const { data, error } = await api.from(bucket).download(normalizeStoragePath(path));
    if (error) {
      if (isNotFound(error)) return null;
      fail('download', error);
    }
    return new Uint8Array(await data.arrayBuffer());
  };

  const upload = async (
    bucket: string,
    path: string,
    body: Uint8Array | Blob | string,
    opts: UploadOptions,
  ): Promise<void> => {
    const { error } = await api.from(bucket).upload(normalizeStoragePath(path), body, {
      contentType: opts.contentType,
      upsert: opts.upsert ?? false,
      cacheControl: opts.cacheControl,
    });
    if (error) fail('upload', error);
  };

  return {
    async signedUrl(bucket, path, expiresInSec) {
      const { data, error } = await api.from(bucket).createSignedUrl(normalizeStoragePath(path), expiresInSec);
      if (error) {
        if (isNotFound(error)) throw httpError('not_found', 'object not found', { cause: error });
        fail('sign', error);
      }
      return data.signedUrl;
    },
    download,
    async downloadText(bucket, path) {
      const bytes = await download(bucket, path);
      return bytes === null ? null : new TextDecoder().decode(bytes);
    },
    async downloadJson<T>(bucket: string, path: string): Promise<T | null> {
      const bytes = await download(bucket, path);
      return bytes === null ? null : (JSON.parse(new TextDecoder().decode(bytes)) as T);
    },
    upload,
    uploadJson(bucket, path, value, opts = {}) {
      return upload(bucket, path, new TextEncoder().encode(JSON.stringify(value)), {
        contentType: 'application/json',
        upsert: opts.upsert ?? true,
      });
    },
    async exists(bucket, path) {
      const full = normalizeStoragePath(path);
      const slash = full.lastIndexOf('/');
      const folder = slash < 0 ? '' : full.slice(0, slash);
      const name = full.slice(slash + 1);
      const { data, error } = await api.from(bucket).list(folder, { limit: 100, offset: 0, search: name });
      if (error) fail('list', error);
      return data.some((e) => e.name === name && e.id !== null);
    },
    list: listAll,
    listRecursive,
    remove,
    async removePrefix(bucket, prefix) {
      const paths = await listRecursive(bucket, normalizeStoragePath(prefix));
      return paths.length ? remove(bucket, paths) : 0;
    },
    move,
    async movePrefix(bucket, fromPrefix, toPrefix, opts = {}) {
      const from = normalizeStoragePath(fromPrefix);
      const to = normalizeStoragePath(toPrefix);
      if (from === to) return 0;
      if (to.startsWith(`${from}/`)) throw new Error('cannot move a prefix into itself');
      const paths = await listRecursive(bucket, from);
      await pool(paths, moveConcurrency, (p) => move(bucket, p, `${to}${p.slice(from.length)}`, opts));
      return paths.length;
    },
  };
}
