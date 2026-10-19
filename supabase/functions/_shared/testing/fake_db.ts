/**
 * In-memory `Db` for handler unit tests: tables are arrays of rows keyed `schema.table`, RPCs are scripted
 * functions keyed `schema.fn`, and every call is recorded.
 */
import type { Db, DbSchema, Match, Row, SelectOptions, WriteOptions } from '../db.ts';
import { HttpError } from '../errors.ts';

export type RpcImpl = (args: Record<string, unknown>) => unknown | Promise<unknown>;

export interface DbCall {
  op: 'rpc' | 'selectOne' | 'selectMany' | 'insert' | 'upsert' | 'update' | 'delete';
  target: string;
  args?: unknown;
}

function matches(row: Row, match: Match): boolean {
  return Object.entries(match).every(([k, v]) => (v === null ? row[k] === null || row[k] === undefined : row[k] === v));
}

function project(row: Row, columns: string): Row {
  const cols = columns.split(',').map((c) => c.trim()).filter(Boolean);
  if (cols.includes('*')) return structuredClone(row);
  const out: Row = {};
  for (const c of cols) out[c] = structuredClone(row[c] ?? null);
  return out;
}

export class FakeDb implements Db {
  readonly tables = new Map<string, Row[]>();
  readonly rpcs = new Map<string, RpcImpl>();
  readonly calls: DbCall[] = [];
  /** When set, the next call (any op) throws this error once. */
  failNext: Error | null = null;

  table(schema: DbSchema, name: string): Row[] {
    const key = `${schema}.${name}`;
    let rows = this.tables.get(key);
    if (!rows) {
      rows = [];
      this.tables.set(key, rows);
    }
    return rows;
  }

  seed(schema: DbSchema, name: string, rows: Row[]): this {
    this.table(schema, name).push(...rows.map((r) => structuredClone(r)));
    return this;
  }

  onRpc(schema: DbSchema, fn: string, impl: RpcImpl): this {
    this.rpcs.set(`${schema}.${fn}`, impl);
    return this;
  }

  callsTo(op: DbCall['op'], target?: string): DbCall[] {
    return this.calls.filter((c) => c.op === op && (target === undefined || c.target === target));
  }

  private record(op: DbCall['op'], target: string, args?: unknown): void {
    this.calls.push({ op, target, args: args === undefined ? undefined : structuredClone(args) });
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
  }

  async rpc<T = unknown>(schema: DbSchema, fn: string, args: Record<string, unknown> = {}): Promise<T> {
    const target = `${schema}.${fn}`;
    this.record('rpc', target, args);
    const impl = this.rpcs.get(target);
    if (!impl) throw new HttpError('internal', `FakeDb: no rpc ${target}`);
    return (await impl(args)) as T;
  }

  /** Runs a synchronous body as a promise, so thrown errors become rejections (like the real client). */
  private run<T>(op: DbCall['op'], target: string, args: unknown, body: () => T): Promise<T> {
    return new Promise<T>((resolve) => {
      this.record(op, target, args);
      resolve(body());
    });
  }

  selectOne<T = Row>(schema: DbSchema, table: string, columns: string, match: Match): Promise<T | null> {
    return this.run('selectOne', `${schema}.${table}`, match, () => {
      const row = this.table(schema, table).find((r) => matches(r, match));
      return row ? (project(row, columns) as T) : null;
    });
  }

  selectMany<T = Row>(
    schema: DbSchema,
    table: string,
    columns: string,
    match: Match,
    options: SelectOptions = {},
  ): Promise<T[]> {
    return this.run('selectMany', `${schema}.${table}`, { match, options }, () => {
      let rows = this.table(schema, table).filter((r) => matches(r, match));
      if (options.order) {
        const { column, ascending = true } = options.order;
        rows = [...rows].sort((a, b) => {
          const x = a[column] as string | number;
          const y = b[column] as string | number;
          return (x < y ? -1 : x > y ? 1 : 0) * (ascending ? 1 : -1);
        });
      }
      if (options.limit !== undefined) rows = rows.slice(0, options.limit);
      return rows.map((r) => project(r, columns) as T);
    });
  }

  insert(schema: DbSchema, table: string, rows: Row | Row[]): Promise<number> {
    const list = Array.isArray(rows) ? rows : [rows];
    return this.run('insert', `${schema}.${table}`, list, () => {
      this.table(schema, table).push(...list.map((r) => structuredClone(r)));
      return list.length;
    });
  }

  upsert(schema: DbSchema, table: string, rows: Row | Row[], options: WriteOptions): Promise<number> {
    const list = Array.isArray(rows) ? rows : [rows];
    return this.run('upsert', `${schema}.${table}`, { rows: list, options }, () => {
      const keys = (options.onConflict ?? 'id').split(',').map((k) => k.trim());
      const target = this.table(schema, table);
      let written = 0;
      for (const row of list) {
        const existing = target.find((r) => keys.every((k) => r[k] === row[k]));
        if (existing) {
          if (options.ignoreDuplicates) continue;
          Object.assign(existing, structuredClone(row));
        } else {
          target.push(structuredClone(row));
        }
        written++;
      }
      return written;
    });
  }

  update(schema: DbSchema, table: string, patch: Row, match: Match): Promise<number> {
    return this.run('update', `${schema}.${table}`, { patch, match }, () => {
      if (Object.keys(match).length === 0) throw new Error('db.update needs at least one filter');
      let n = 0;
      for (const row of this.table(schema, table)) {
        if (matches(row, match)) {
          Object.assign(row, structuredClone(patch));
          n++;
        }
      }
      return n;
    });
  }

  delete(schema: DbSchema, table: string, match: Match): Promise<number> {
    return this.run('delete', `${schema}.${table}`, match, () => {
      if (Object.keys(match).length === 0) throw new Error('db.delete needs at least one filter');
      const rows = this.table(schema, table);
      const keep = rows.filter((r) => !matches(r, match));
      const n = rows.length - keep.length;
      rows.splice(0, rows.length, ...keep);
      return n;
    });
  }
}
