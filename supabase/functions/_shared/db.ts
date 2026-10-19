/**
 * Service-role database access (DESIGN-v1.0 §6.1 `db.ts`).
 *
 * Handlers depend on the small `Db` / `AuthAdmin` interfaces, not on supabase-js, so unit tests pass the in-memory
 * fakes from `_shared/testing`. `createServiceClients(env)` builds the real implementations over one supabase-js
 * client (secret key: bypasses RLS; `private` is reachable because config.toml exposes it to the API).
 *
 * Errors: a PostgREST error whose SQLSTATE is `PTnnn` with an ApiErrorCode message becomes that HttpError; anything
 * else becomes 500 `internal` (cause kept for the log).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { fromPostgrestError, httpError } from './errors.ts';
import type { ServerEnv } from './env.ts';
import { fetchWithTimeout } from './http.ts';
import { createStorageService, type StorageService } from './storage.ts';

export type DbSchema = 'public' | 'private';
export type Row = Record<string, unknown>;
/** Equality filters; `null` means `IS NULL`. */
export type Match = Record<string, string | number | boolean | null>;

export interface SelectOptions {
  order?: { column: string; ascending?: boolean };
  limit?: number;
}

export interface WriteOptions {
  /** Upsert conflict target (comma-separated columns). */
  onConflict?: string;
  /** Upsert: `ON CONFLICT DO NOTHING` instead of update. */
  ignoreDuplicates?: boolean;
}

export interface Db {
  /** Calls `schema.fn(args)`; returns the function's JSON result. */
  rpc<T = unknown>(schema: DbSchema, fn: string, args?: Record<string, unknown>): Promise<T>;
  /** First matching row or null. */
  selectOne<T = Row>(schema: DbSchema, table: string, columns: string, match: Match): Promise<T | null>;
  selectMany<T = Row>(
    schema: DbSchema,
    table: string,
    columns: string,
    match: Match,
    options?: SelectOptions,
  ): Promise<T[]>;
  /** Inserts rows; returns the number inserted. */
  insert(schema: DbSchema, table: string, rows: Row | Row[]): Promise<number>;
  /** Inserts or updates on `onConflict`; returns the number of rows written. */
  upsert(schema: DbSchema, table: string, rows: Row | Row[], options: WriteOptions): Promise<number>;
  /** Updates matching rows; returns the count. An empty `match` is refused (no accidental full-table writes). */
  update(schema: DbSchema, table: string, patch: Row, match: Match): Promise<number>;
  /** Deletes matching rows; returns the count. An empty `match` is refused. */
  delete(schema: DbSchema, table: string, match: Match): Promise<number>;
}

export interface AdminUser {
  id: string;
  isAnonymous: boolean;
  email: string | null;
  createdAt: string | null;
}

export interface AuthAdmin {
  /** null when the user does not exist. */
  getUser(userId: string): Promise<AdminUser | null>;
  /** Hard delete. false when the user was already gone (idempotent). */
  deleteUser(userId: string): Promise<boolean>;
}

/** Everything a handler needs from Supabase with service rights. */
export interface ServiceClients {
  db: Db;
  storage: StorageService;
  authAdmin: AuthAdmin;
}

/** Default per-request timeout for Supabase API calls made by the service client. */
export const SERVICE_FETCH_TIMEOUT_MS = 20_000;

export function createServiceSupabase(
  env: Pick<ServerEnv, 'supabaseUrl' | 'serviceKey'>,
  timeoutMs = SERVICE_FETCH_TIMEOUT_MS,
): SupabaseClient {
  return createClient(env.supabaseUrl, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fetchWithTimeout(timeoutMs) as typeof fetch },
  });
}

function assertMatch(match: Match, op: string): void {
  if (Object.keys(match).length === 0) throw new Error(`db.${op} needs at least one filter`);
}

/**
 * The slice of the postgrest-js 2.117.2 builders used here, without their select-string type parsing (a runtime
 * `columns` string makes that inference explode with TS2589). Awaiting a builder yields `PgResult`.
 */
interface PgResult {
  data: unknown;
  error: { code?: string; message?: string; details?: string; hint?: string } | null;
  count?: number | null;
}
type CountOption = { count?: 'exact' };
interface LooseQuery extends PromiseLike<PgResult> {
  eq(column: string, value: unknown): LooseQuery;
  is(column: string, value: null): LooseQuery;
  order(column: string, options: { ascending: boolean }): LooseQuery;
  limit(n: number): LooseQuery;
}
interface LooseTable {
  select(columns: string): LooseQuery;
  insert(rows: Row | Row[], options: CountOption): LooseQuery;
  upsert(rows: Row | Row[], options: CountOption & { onConflict?: string; ignoreDuplicates?: boolean }): LooseQuery;
  update(patch: Row, options: CountOption): LooseQuery;
  delete(options: CountOption): LooseQuery;
}

function applyMatch(q: LooseQuery, match: Match): LooseQuery {
  let out = q;
  for (const [col, value] of Object.entries(match)) out = value === null ? out.is(col, null) : out.eq(col, value);
  return out;
}

export function createDb(client: SupabaseClient): Db {
  const from = (schema: DbSchema, table: string) => client.schema(schema).from(table) as unknown as LooseTable;
  const check = (res: PgResult): unknown => {
    if (res.error) throw fromPostgrestError(res.error);
    return res.data;
  };

  return {
    async rpc<T>(schema: DbSchema, fn: string, args: Record<string, unknown> = {}): Promise<T> {
      const res = await client.schema(schema).rpc(fn, args);
      if (res.error) throw fromPostgrestError(res.error);
      return res.data as T;
    },
    async selectOne<T>(schema: DbSchema, table: string, columns: string, match: Match): Promise<T | null> {
      const rows = check(await applyMatch(from(schema, table).select(columns), match).limit(1)) as T[] | null;
      return rows && rows.length ? rows[0] : null;
    },
    async selectMany<T>(
      schema: DbSchema,
      table: string,
      columns: string,
      match: Match,
      options: SelectOptions = {},
    ): Promise<T[]> {
      let q = applyMatch(from(schema, table).select(columns), match);
      if (options.order) q = q.order(options.order.column, { ascending: options.order.ascending ?? true });
      if (options.limit !== undefined) q = q.limit(options.limit);
      return (check(await q) as T[] | null) ?? [];
    },
    async insert(schema: DbSchema, table: string, rows: Row | Row[]): Promise<number> {
      const res = await from(schema, table).insert(rows, { count: 'exact' });
      check(res);
      return res.count ?? (Array.isArray(rows) ? rows.length : 1);
    },
    async upsert(schema: DbSchema, table: string, rows: Row | Row[], options: WriteOptions): Promise<number> {
      const res = await from(schema, table).upsert(rows, {
        onConflict: options.onConflict,
        ignoreDuplicates: options.ignoreDuplicates ?? false,
        count: 'exact',
      });
      check(res);
      return res.count ?? 0;
    },
    async update(schema: DbSchema, table: string, patch: Row, match: Match): Promise<number> {
      assertMatch(match, 'update');
      const res = await applyMatch(from(schema, table).update(patch, { count: 'exact' }), match);
      check(res);
      return res.count ?? 0;
    },
    async delete(schema: DbSchema, table: string, match: Match): Promise<number> {
      assertMatch(match, 'delete');
      const res = await applyMatch(from(schema, table).delete({ count: 'exact' }), match);
      check(res);
      return res.count ?? 0;
    },
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createAuthAdmin(client: SupabaseClient): AuthAdmin {
  const admin = client.auth.admin;
  const isNotFound = (e: { status?: number; code?: string } | null) =>
    e?.status === 404 || e?.code === 'user_not_found';
  return {
    async getUser(userId) {
      if (!UUID_RE.test(userId)) return null; // supabase-js would throw a plain Error
      const { data, error } = await admin.getUserById(userId);
      if (error) {
        if (isNotFound(error)) return null;
        throw httpError('upstream_unavailable', 'auth admin failed', { cause: error });
      }
      const u = data.user;
      return {
        id: u.id.toLowerCase(),
        isAnonymous: u.is_anonymous === true,
        email: u.email ?? null,
        createdAt: u.created_at ?? null,
      };
    },
    async deleteUser(userId) {
      if (!UUID_RE.test(userId)) return false;
      const { error } = await admin.deleteUser(userId, false);
      if (error) {
        if (isNotFound(error)) return false;
        throw httpError('upstream_unavailable', 'auth admin failed', { cause: error });
      }
      return true;
    },
  };
}

let cachedClients: ServiceClients | null = null;

/** Real service clients (cached per worker: one HTTP client, one JWKS cache). */
export function createServiceClients(env: Pick<ServerEnv, 'supabaseUrl' | 'serviceKey'>): ServiceClients {
  const client = createServiceSupabase(env);
  return { db: createDb(client), storage: createStorageService(client.storage), authAdmin: createAuthAdmin(client) };
}

export function getServiceClients(env: Pick<ServerEnv, 'supabaseUrl' | 'serviceKey'>): ServiceClients {
  cachedClients ??= createServiceClients(env);
  return cachedClients;
}
