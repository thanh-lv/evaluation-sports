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

// deno-lint-ignore no-explicit-any
function applyMatch<Q extends { eq: (c: string, v: any) => Q; is: (c: string, v: null) => Q }>(q: Q, match: Match): Q {
  let out = q;
  for (const [col, value] of Object.entries(match)) out = value === null ? out.is(col, null) : out.eq(col, value);
  return out;
}

export function createDb(client: SupabaseClient): Db {
  const from = (schema: DbSchema, table: string) => client.schema(schema).from(table);
  const check = <T>(res: { data: T; error: { code?: string; message?: string } | null }): T => {
    if (res.error) throw fromPostgrestError(res.error);
    return res.data;
  };

  return {
    async rpc<T>(schema: DbSchema, fn: string, args: Record<string, unknown> = {}): Promise<T> {
      return check(await client.schema(schema).rpc(fn, args)) as T;
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

export function createAuthAdmin(client: SupabaseClient): AuthAdmin {
  const admin = client.auth.admin;
  const isNotFound = (e: { status?: number; code?: string } | null) => e?.status === 404 || e?.code === 'user_not_found';
  return {
    async getUser(userId) {
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
