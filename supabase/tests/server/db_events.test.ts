/**
 * `_shared/db.ts` and `_shared/events.ts`: the in-memory FakeDb, and the real service clients against the local
 * stack (throwaway `events` rows named `test.infra_*` and `app_config` keys `test_infra_*`, removed at the end).
 */
import { assert, assertEquals, assertRejects } from '@std/assert';
import { createServiceClients } from '@shared/db.ts';
import { HttpError } from '@shared/errors.ts';
import { EVENT_PROPS_MAX_BYTES, jsonbTextBytes, logServerEvent, prepareEventProps } from '@shared/events.ts';
import { captureLogger, FakeDb, fakeServiceClients } from '@shared/testing/index.ts';
import { createTestUser, deleteTestUser, getLocalStack } from '@shared/testing/local_stack.ts';

/** Props whose jsonb text is exactly `bytes` long (strings stay ≤ 500 chars: longer ones are truncated by scrub). */
function propsOfSize(bytes: number): Record<string, string> {
  const props: Record<string, string> = {};
  for (let i = 0; i < 9; i++) props[`a${i}`] = 'x'.repeat(200);
  props.a9 = '';
  props.a9 = 'x'.repeat(bytes - jsonbTextBytes(props));
  assertEquals(jsonbTextBytes(props), bytes);
  return props;
}

// ---------------------------------------------------------------------------------------------------------------
// Fakes

Deno.test('FakeDb: tables, filters, ordering, upsert, update/delete guards, scripted rpc and call log', async () => {
  const db = new FakeDb()
    .seed('public', 'analyses', [
      { id: 'a1', user_id: 'u1', status: 'prepared', created_at: '2026-10-02' },
      { id: 'a2', user_id: 'u1', status: 'queued', created_at: '2026-10-01' },
      { id: 'a3', user_id: 'u2', status: 'queued', created_at: '2026-10-03', failure_code: null },
    ])
    .onRpc('private', 'reserve_for_submit', (args) => ({ ok: args.p_user_id === 'u1' }));

  assertEquals(await db.selectOne('public', 'analyses', 'id, status', { id: 'a1' }), { id: 'a1', status: 'prepared' });
  assertEquals(await db.selectOne('public', 'analyses', '*', { id: 'zz' }), null);
  const queued = await db.selectMany<{ id: string }>('public', 'analyses', 'id', { status: 'queued' }, {
    order: { column: 'created_at', ascending: false },
    limit: 5,
  });
  assertEquals(queued.map((r) => r.id), ['a3', 'a2']);
  assertEquals((await db.selectMany('public', 'analyses', 'id', { failure_code: null })).length, 3);

  assertEquals(await db.update('public', 'analyses', { status: 'processing' }, { user_id: 'u1' }), 2);
  await assertRejects(() => db.update('public', 'analyses', { status: 'x' }, {}), Error, 'filter');
  await assertRejects(() => db.delete('public', 'analyses', {}), Error, 'filter');
  assertEquals(await db.delete('public', 'analyses', { id: 'a3' }), 1);

  assertEquals(await db.upsert('public', 'app_config', { key: 'k', value: 1 }, { onConflict: 'key' }), 1);
  assertEquals(await db.upsert('public', 'app_config', { key: 'k', value: 2 }, { onConflict: 'key' }), 1);
  assertEquals(
    await db.upsert('public', 'app_config', { key: 'k', value: 3 }, { onConflict: 'key', ignoreDuplicates: true }),
    0,
  );
  assertEquals(db.table('public', 'app_config'), [{ key: 'k', value: 2 }]);

  assertEquals(await db.rpc('private', 'reserve_for_submit', { p_user_id: 'u1' }), { ok: true });
  await assertRejects(() => db.rpc('private', 'unknown_fn'), HttpError);
  assertEquals(db.callsTo('rpc').length, 2);
  assertEquals(db.callsTo('update', 'public.analyses')[0].args, {
    patch: { status: 'processing' },
    match: { user_id: 'u1' },
  });

  db.failNext = new HttpError('upstream_unavailable');
  await assertRejects(() => db.selectOne('public', 'analyses', 'id', { id: 'a1' }), HttpError);
  assertEquals((await db.selectOne('public', 'analyses', 'id', { id: 'a1' }))?.id, 'a1', 'failNext fires once');
});

Deno.test('fakeServiceClients bundles FakeDb, MemoryStorage and FakeAuthAdmin', async () => {
  const c = fakeServiceClients();
  c.authAdmin.addUser({ id: 'u1', isAnonymous: true });
  assertEquals((await c.authAdmin.getUser('u1'))?.isAnonymous, true);
  assertEquals(await c.authAdmin.deleteUser('u1'), true);
  assertEquals(await c.authAdmin.deleteUser('u1'), false);
  assertEquals(c.authAdmin.deleted, ['u1']);
  await c.storage.uploadJson('analysis-derived', 'u/a/x.json', { ok: 1 });
  assertEquals(c.memory.paths('analysis-derived'), ['u/a/x.json']);
});

Deno.test('prepareEventProps: name pattern, object props, PII scrub, 2 KB jsonb limit', () => {
  assertEquals(prepareEventProps('Bad Name').ok, false);
  assertEquals(prepareEventProps('x').ok, false, 'two chars minimum');
  assertEquals(prepareEventProps('ok.name', [] as unknown as Record<string, unknown>).ok, false);
  const p = prepareEventProps('analysis.succeeded', {
    model: 'm',
    email: 'a@b.cc',
    userId: '0f8fad5b-d9cb-469f-a165-70867728950e',
    skipped: undefined,
  });
  assert(p.ok);
  assertEquals(p.props.model, 'm');
  assertEquals(p.props.email, '[redacted]');
  assert(!JSON.stringify(p.props).includes('0f8fad5b'));
  assert(!('skipped' in p.props));
  // jsonb::text of {"p": "<n chars>"} is n + 9 bytes
  assertEquals(jsonbTextBytes({ p: 'x'.repeat(10) }), 19);
  assertEquals(jsonbTextBytes({ a: [1, 2], b: { c: null } }), '{"a": [1, 2], "b": {"c": null}}'.length);
  assertEquals(prepareEventProps('big.ok', propsOfSize(EVENT_PROPS_MAX_BYTES)).ok, true);
  assertEquals(prepareEventProps('big.no', propsOfSize(EVENT_PROPS_MAX_BYTES + 1)).ok, false);
  // like log fields, long strings are truncated (500 chars) before the size check
  const long = prepareEventProps('long.text', { note: 'y'.repeat(5000) });
  assert(long.ok && String(long.props.note).length <= 501);
});

Deno.test('logServerEvent writes a server row, and never throws', async () => {
  const db = new FakeDb();
  const { log, lines } = captureLogger();
  assert(await logServerEvent(db, { name: 'cron.daily', userId: null, props: { n: 1 } }, log));
  assert(await logServerEvent(db, { name: 'analysis.failed', userId: 'ABC', props: {} }, log));
  assertEquals(db.table('public', 'events'), [
    { user_id: null, name: 'cron.daily', props: { n: 1 }, source: 'server' },
    { user_id: 'abc', name: 'analysis.failed', props: {}, source: 'server' },
  ]);
  assertEquals(await logServerEvent(db, { name: 'BAD', userId: null }, log), false);
  db.failNext = new Error('db down');
  assertEquals(await logServerEvent(db, { name: 'x.y', userId: null }, log), false);
  assertEquals(lines.filter((l) => l.level === 'warn').length, 2);
});

// ---------------------------------------------------------------------------------------------------------------
// Local stack

const stack = await getLocalStack();
const live = { ignore: !stack, sanitizeOps: false, sanitizeResources: false };
const tag = crypto.randomUUID().replace(/-/g, '').slice(0, 12);

Deno.test({
  name: 'local stack: Db over PostgREST (insert/select/upsert/update/delete, rpc error mapping, private schema)',
  ...live,
  fn: async () => {
    const { db } = createServiceClients({ supabaseUrl: stack!.url, serviceKey: stack!.serviceKey });
    const name = `test.infra_${tag}`;
    const key = `test_infra_${tag}`;
    try {
      assertEquals(
        await db.insert('public', 'events', [
          { name, props: { i: 1 }, source: 'server' },
          { name, props: { i: 2 }, source: 'server' },
        ]),
        2,
      );
      const rows = await db.selectMany<{ props: { i: number }; user_id: null }>('public', 'events', 'props, user_id', {
        name,
        user_id: null,
      }, { order: { column: 'id', ascending: false }, limit: 5 });
      assertEquals(rows.map((r) => r.props.i), [2, 1]);
      assertEquals(await db.selectOne('public', 'events', 'id', { name: `${name}_none` }), null);

      assertEquals(await db.upsert('public', 'app_config', { key, value: 1 }, { onConflict: 'key' }), 1);
      assertEquals(await db.upsert('public', 'app_config', { key, value: 2 }, { onConflict: 'key' }), 1);
      assertEquals(
        await db.upsert('public', 'app_config', { key, value: 3 }, { onConflict: 'key', ignoreDuplicates: true }),
        0,
      );
      assertEquals(await db.selectOne('public', 'app_config', 'value', { key }), { value: 2 });
      assertEquals(await db.update('public', 'app_config', { value: { v: 4 } }, { key }), 1);
      assertEquals(await db.update('public', 'app_config', { value: 5 }, { key: `${key}_none` }), 0);
      assertEquals((await db.selectOne<{ value: unknown }>('public', 'app_config', 'value', { key }))?.value, { v: 4 });

      // CHECK violation → internal (no SQL detail leaks to the client)
      const bad = await assertRejects(() => db.insert('public', 'events', { name: 'Bad Name' }), HttpError);
      assertEquals(bad.code, 'internal');
      // client RPC raising PT401 'unauthorized' (no auth.uid() for the service role)
      const pt = await assertRejects(() => db.rpc('public', 'get_result', { p_analysis_id: crypto.randomUUID() }));
      assertEquals((pt as HttpError).code, 'unauthorized');
      assertEquals((pt as HttpError).status, 401);
      const missing = await assertRejects(() => db.rpc('public', 'no_such_function_xyz'), HttpError);
      assertEquals(missing.code, 'internal');
      // private schema is reachable with the service key
      assertEquals(await db.selectMany('private', 'audit_log', 'id', { action: `none_${tag}` }), []);
      // guard against unfiltered writes
      await assertRejects(() => db.delete('public', 'events', {}), Error, 'filter');
    } finally {
      assertEquals(await db.delete('public', 'events', { name }), 2);
      await db.delete('public', 'app_config', { key });
    }
  },
});

Deno.test({
  name: 'local stack: AuthAdmin getUser/deleteUser are idempotent and report anonymity',
  ...live,
  fn: async () => {
    const { authAdmin } = createServiceClients({ supabaseUrl: stack!.url, serviceKey: stack!.serviceKey });
    assertEquals(await authAdmin.getUser(crypto.randomUUID()), null);
    assertEquals(await authAdmin.deleteUser(crypto.randomUUID()), false);
    assertEquals(await authAdmin.getUser('not-a-uuid'), null);
    assertEquals(await authAdmin.deleteUser('not-a-uuid'), false);
    const user = await createTestUser(stack!);
    try {
      const u = await authAdmin.getUser(user.userId.toUpperCase());
      assertEquals(u?.id, user.userId);
      assertEquals(u?.isAnonymous, false);
      assert(u?.email?.endsWith('@example.invalid'));
      assertEquals(await authAdmin.deleteUser(user.userId), true);
      assertEquals(await authAdmin.getUser(user.userId), null);
    } finally {
      await deleteTestUser(stack!, user.userId);
    }
  },
});

Deno.test({
  name: 'local stack: logServerEvent stores server rows; the 2 KB limit matches Postgres',
  ...live,
  fn: async () => {
    const { db, authAdmin } = createServiceClients({ supabaseUrl: stack!.url, serviceKey: stack!.serviceKey });
    const { log, lines } = captureLogger();
    const user = await createTestUser(stack!);
    const name = `test.infra_ev_${tag}`;
    try {
      assert(await logServerEvent(db, { name, userId: user.userId.toUpperCase(), props: { step: 'a' } }, log));
      const max = propsOfSize(EVENT_PROPS_MAX_BYTES);
      assert(await logServerEvent(db, { name, userId: null, props: max }, log), 'exactly 2048 bytes is accepted');
      // one byte more: our check refuses, and so does the table CHECK when the check is bypassed
      const over = propsOfSize(EVENT_PROPS_MAX_BYTES + 1);
      assertEquals(await logServerEvent(db, { name, userId: null, props: over }, log), false);
      await assertRejects(() => db.insert('public', 'events', { name, props: over, source: 'server' }));
      // unknown user (FK) → false + warning, never a throw
      assertEquals(await logServerEvent(db, { name, userId: crypto.randomUUID(), props: {} }, log), false);
      const stored = await db.selectMany<{ user_id: string | null; source: string }>(
        'public',
        'events',
        'user_id, source',
        { name },
        { order: { column: 'id', ascending: true } },
      );
      assertEquals(stored, [{ user_id: user.userId, source: 'server' }, { user_id: null, source: 'server' }]);
      assertEquals(lines.filter((l) => l.level === 'warn').length, 2);
    } finally {
      await db.delete('public', 'events', { name });
      await authAdmin.deleteUser(user.userId);
    }
  },
});
