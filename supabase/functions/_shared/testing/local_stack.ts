/**
 * Access to the local Supabase stack for integration tests (`supabase start`, project racketcoach).
 *
 * Keys come from env (`SUPABASE_URL` + `SUPABASE_SECRET_KEY`/`SUPABASE_SERVICE_ROLE_KEY` +
 * `SUPABASE_PUBLISHABLE_KEY`/`SUPABASE_ANON_KEY`) or from `npx supabase status -o env`. When the stack is not
 * reachable (no Docker, CI without Supabase) `getLocalStack()` returns null and tests should be ignored:
 *
 *   const stack = await getLocalStack();
 *   Deno.test({ name: '…', ignore: !stack, fn: async () => { … } });
 *
 * Set `RC_SKIP_LOCAL_STACK=1` to force-skip. Test users are created through the admin API (no sign-up rate limit)
 * and must be removed with `deleteTestUser`.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface LocalStack {
  url: string;
  anonKey: string;
  serviceKey: string;
  /** Legacy HS256 secret, when `supabase status` reports it. */
  jwtSecret: string | null;
}

const REPO_ROOT = new URL('../../../../', import.meta.url);
let cached: Promise<LocalStack | null> | null = null;

function parseEnvLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z0-9_]+)="?(.*?)"?$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function fromCli(): Promise<Record<string, string>> {
  const version = Deno.env.get('SUPABASE_CLI_VERSION') ?? '2.119.0';
  try {
    const out = await new Deno.Command('npx', {
      args: ['-y', `supabase@${version}`, 'status', '-o', 'env'],
      cwd: REPO_ROOT,
      stdout: 'piped',
      stderr: 'null',
      signal: AbortSignal.timeout(60_000),
    }).output();
    return out.success ? parseEnvLines(new TextDecoder().decode(out.stdout)) : {};
  } catch {
    return {};
  }
}

async function reachable(stack: LocalStack): Promise<boolean> {
  try {
    const res = await fetch(`${stack.url}/auth/v1/health`, {
      headers: { apikey: stack.anonKey },
      signal: AbortSignal.timeout(3000),
    });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

async function resolve(): Promise<LocalStack | null> {
  if (Deno.env.get('RC_SKIP_LOCAL_STACK') === '1') return null;
  const env = (n: string) => Deno.env.get(n) || undefined;
  let url = env('SUPABASE_URL');
  let serviceKey = env('SUPABASE_SECRET_KEY') ?? env('SUPABASE_SERVICE_ROLE_KEY');
  let anonKey = env('SUPABASE_PUBLISHABLE_KEY') ?? env('SUPABASE_ANON_KEY');
  let jwtSecret = env('SUPABASE_JWT_SECRET') ?? null;
  if (!url || !serviceKey || !anonKey) {
    const cli = await fromCli();
    url = cli.API_URL;
    serviceKey = cli.SECRET_KEY ?? cli.SERVICE_ROLE_KEY;
    anonKey = cli.PUBLISHABLE_KEY ?? cli.ANON_KEY;
    jwtSecret = cli.JWT_SECRET ?? null;
  }
  if (!url || !serviceKey || !anonKey) return null;
  const stack = { url, anonKey, serviceKey, jwtSecret };
  return (await reachable(stack)) ? stack : null;
}

/** The running local stack, or null (cached per test process). */
export function getLocalStack(): Promise<LocalStack | null> {
  cached ??= resolve();
  return cached;
}

const NO_SESSION = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const;

export function serviceClient(stack: LocalStack): SupabaseClient {
  return createClient(stack.url, stack.serviceKey, { auth: NO_SESSION });
}

export interface TestUser {
  userId: string;
  accessToken: string;
  isAnonymous: boolean;
}

/** A confirmed email user created through the admin API, signed in with a password. */
export async function createTestUser(stack: LocalStack): Promise<TestUser> {
  const admin = serviceClient(stack);
  const email = `infra-test-${crypto.randomUUID()}@example.invalid`;
  const password = `pw-${crypto.randomUUID()}`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw created.error;
  const client = createClient(stack.url, stack.anonKey, { auth: NO_SESSION });
  const signed = await client.auth.signInWithPassword({ email, password });
  if (signed.error || !signed.data.session) throw signed.error ?? new Error('no session');
  return { userId: created.data.user.id, accessToken: signed.data.session.access_token, isAnonymous: false };
}

/** An anonymous user (counts against the per-IP anonymous sign-in limit, 30/h locally: use sparingly). */
export async function createAnonymousUser(stack: LocalStack): Promise<TestUser> {
  const client = createClient(stack.url, stack.anonKey, { auth: NO_SESSION });
  const { data, error } = await client.auth.signInAnonymously();
  if (error || !data.session || !data.user) throw error ?? new Error('no session');
  return { userId: data.user.id, accessToken: data.session.access_token, isAnonymous: true };
}

export async function deleteTestUser(stack: LocalStack, userId: string): Promise<void> {
  await serviceClient(stack).auth.admin.deleteUser(userId);
}
