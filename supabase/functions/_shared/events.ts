/**
 * Server-side analytics events (D22): rows in `public.events` with `source = 'server'`.
 *
 * Same limits as the table CHECKs (name `^[a-z][a-z0-9_.]{1,63}$`, props an object ≤ 2 KB as jsonb text) and the
 * same PII rules as the logs (no emails/tokens/coordinates; user ids only in the `user_id` column). Analytics must
 * never fail a request, so `logServerEvent` returns false and logs a warning instead of throwing.
 */
import type { Db } from './db.ts';
import { errorFields, type Logger, scrubFields } from './log.ts';

export const EVENT_NAME_RE = /^[a-z][a-z0-9_.]{1,63}$/;
export const EVENT_PROPS_MAX_BYTES = 2048;

export interface ServerEvent {
  name: string;
  /** null for system events (e.g. cron). Must reference an existing profile. */
  userId: string | null;
  props?: Record<string, unknown>;
}

/** Byte length of the value as Postgres prints `jsonb::text` (`{"a": 1, "b": [1, 2]}`: spaces after `:` and `,`). */
export function jsonbTextBytes(value: unknown): number {
  const render = (v: unknown): string => {
    if (v === null || v === undefined) return 'null';
    if (Array.isArray(v)) return `[${v.map(render).join(', ')}]`;
    if (typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
      return `{${entries.map(([k, x]) => `${JSON.stringify(k)}: ${render(x)}`).join(', ')}}`;
    }
    return JSON.stringify(v) ?? 'null';
  };
  return new TextEncoder().encode(render(value)).length;
}

/** Validates and scrubs; returns the props to store or an error string. */
export function prepareEventProps(
  name: string,
  props: Record<string, unknown> = {},
): { ok: true; props: Record<string, unknown> } | { ok: false; reason: string } {
  if (!EVENT_NAME_RE.test(name)) return { ok: false, reason: 'bad event name' };
  if (props === null || typeof props !== 'object' || Array.isArray(props)) {
    return { ok: false, reason: 'props must be an object' };
  }
  // user ids belong in the user_id column, and the PII rules apply to props as to logs
  const cleaned = JSON.parse(JSON.stringify(scrubFields(props))) as Record<string, unknown>;
  if (jsonbTextBytes(cleaned) > EVENT_PROPS_MAX_BYTES) return { ok: false, reason: 'props larger than 2 KB' };
  return { ok: true, props: cleaned };
}

/** Inserts one server event. Never throws; false when it was not stored. */
export async function logServerEvent(db: Db, event: ServerEvent, log: Logger): Promise<boolean> {
  const prepared = prepareEventProps(event.name, event.props);
  if (!prepared.ok) {
    log.warn('server event rejected', { event: event.name, reason: prepared.reason });
    return false;
  }
  try {
    await db.insert('public', 'events', {
      user_id: event.userId?.toLowerCase() ?? null,
      name: event.name,
      props: prepared.props,
      source: 'server',
    });
    return true;
  } catch (err) {
    log.warn('server event not stored', { event: event.name, ...errorFields(err) });
    return false;
  }
}
