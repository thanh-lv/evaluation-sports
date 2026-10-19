/**
 * End-to-end flow against the local Supabase stack (DESIGN.md §2.2, §6.1, D12), with CLAUDE_MODE=mock:
 *
 *   anonymous sign-in → profile birth year + consents → POST /analyze/prepare (synthetic pose) → 5 JPEG frames to
 *   Storage → POST /analyze/submit (202) → poll analyses.status → rpc get_result (free redaction) → a second free
 *   analysis uses the quota → the third gets 402.
 *
 * It starts `supabase functions serve` itself (see supabase/tests/e2e/README.md) and stops it at the end. Skipped with
 * a notice when the stack is not running, or with RC_SKIP_E2E=1.
 */
import { assert, assertEquals } from '@std/assert';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { CoachResultV1, PoseV1, PrepareResponseV1, SubmitResponse } from '@shared/contracts/index.ts';
import { createAnonymousUser, getLocalStack, type LocalStack, serviceClient } from '@shared/testing/local_stack.ts';
import { loadFixture } from '../_helpers/fixtures.ts';

const REPO = new URL('../../../', import.meta.url).pathname;
const CLI = Deno.env.get('SUPABASE_CLI_VERSION') ?? '2.119.0';
const NO_SESSION = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const;
/** A tiny JPEG (the mock model never decodes it; Storage only checks the content type). */
const JPEG = Uint8Array.from(
  atob(
    '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////' +
      '////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  ),
  (c) => c.charCodeAt(0),
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const projectId = () =>
  /^project_id = "(.*)"$/m.exec(Deno.readTextFileSync(`${REPO}supabase/config.toml`))?.[1] ?? 'racketcoach';

const skipReason = Deno.env.get('RC_SKIP_E2E') === '1' ? 'RC_SKIP_E2E=1' : null;
const stack: LocalStack | null = skipReason ? null : await getLocalStack();
if (!stack && !skipReason && Deno.env.get('RC_E2E_REQUIRE') === '1') {
  // scripts/check.sh sets this after it has seen the stack answer: a lost stack is a failure, not a silent skip.
  Deno.test('e2e: local Supabase stack required (RC_E2E_REQUIRE=1)', () => {
    throw new Error('local Supabase stack not reachable (npx supabase status -o env failed)');
  });
} else if (!stack) {
  console.warn(
    `e2e flow skipped: ${
      skipReason ?? 'local Supabase stack not running (npx supabase start)'
    }; see supabase/tests/e2e/README.md`,
  );
}

interface Served {
  stop(): Promise<void>;
  internalSecret: string;
  cronSecret: string;
  log: string;
}

/** Writes a mock-mode env file (or uses RC_E2E_ENV_FILE) and starts `functions serve` unless RC_E2E_SERVE=0. */
async function serveFunctions(s: LocalStack): Promise<Served> {
  const dir = await Deno.makeTempDir({ prefix: 'rc-e2e-' });
  const log = `${dir}/serve.log`; // stderr goes to serve.err.log next to it
  let envFile = Deno.env.get('RC_E2E_ENV_FILE');
  let internalSecret = `e2e-internal-${crypto.randomUUID()}`;
  let cronSecret = `e2e-cron-${crypto.randomUUID()}`;
  if (envFile) {
    const text = await Deno.readTextFile(envFile);
    internalSecret = /^INTERNAL_SECRET=(.*)$/m.exec(text)?.[1]?.trim() ?? internalSecret;
    cronSecret = /^CRON_SECRET=(.*)$/m.exec(text)?.[1]?.trim() ?? cronSecret;
  } else {
    envFile = `${dir}/functions.env`;
    await Deno.writeTextFile(
      envFile,
      [
        'CLAUDE_MODE=mock',
        'ANTHROPIC_API_KEY=',
        `INTERNAL_SECRET=${internalSecret}`,
        `CRON_SECRET=${cronSecret}`,
        'TOKEN_ENC_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        'AUDIT_PEPPER=e2e-pepper',
        'LOG_LEVEL=info',
        '',
      ].join('\n'),
    );
  }
  if (Deno.env.get('RC_E2E_SERVE') === '0') {
    return { stop: () => Promise.resolve(), internalSecret, cronSecret, log: '(served externally)' };
  }
  const out = await Deno.open(log, { write: true, create: true, truncate: true });
  const err = await Deno.open(`${dir}/serve.err.log`, { write: true, create: true, truncate: true });
  const child = new Deno.Command('npx', {
    args: ['-y', `supabase@${CLI}`, 'functions', 'serve', '--env-file', envFile, '--no-verify-jwt'],
    cwd: REPO,
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  const pump = Promise.all([
    child.stdout.pipeTo(out.writable).catch(() => {}),
    child.stderr.pipeTo(err.writable).catch(() => {}),
  ]);
  // Ready when the analyze worker boots and answers its own 401 (the first boot downloads npm packages).
  const deadline = Date.now() + 240_000;
  while (true) {
    try {
      const res = await fetch(`${s.url}/functions/v1/analyze/catalog`, { signal: AbortSignal.timeout(60_000) });
      const body = await res.text();
      if (res.status === 401 && body.includes('unauthorized')) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) {
      child.kill('SIGINT');
      throw new Error(`functions serve did not come up; see ${log}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return {
    internalSecret,
    cronSecret,
    log,
    async stop() {
      try {
        child.kill('SIGINT');
      } catch { /* already gone */ }
      const exited = await Promise.race([child.status.then(() => true), sleep(15_000).then(() => false)]);
      if (!exited) {
        // npx does not always forward the signal; removing the container makes the CLI exit on its own
        await new Deno.Command('docker', { args: ['rm', '-f', `supabase_edge_runtime_${projectId()}`] }).output()
          .catch(() => {});
        await Promise.race([child.status, sleep(15_000)]);
      }
      await pump;
    },
  };
}

async function call(
  s: LocalStack,
  path: string,
  token: string | null,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await fetch(`${s.url}/functions/v1/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      apikey: s.anonKey,
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

async function newPose(): Promise<PoseV1> {
  const pose = await loadFixture<PoseV1>('pose/synthetic_bd_clear_fh_60.json');
  pose.analysisId = crypto.randomUUID();
  return pose;
}

/** prepare → upload the requested frames → submit; returns the submit response. */
async function prepareUploadSubmit(s: LocalStack, user: SupabaseClient, uid: string, token: string) {
  const pose = await newPose();
  const prep = await call(s, 'analyze/prepare', token, pose);
  assertEquals(prep.status, 200, prep.text);
  const body = PrepareResponseV1.parse(prep.json);
  const uploads = body.frameRequests.filter((f) => f.upload).map((f) => f.frameId);
  assertEquals(uploads.length, 5);
  for (const f of uploads) {
    const { error } = await user.storage.from('analysis-inputs').upload(
      `${uid}/${pose.analysisId}/frames/${f}.jpg`,
      new Blob([JPEG], { type: 'image/jpeg' }),
      { contentType: 'image/jpeg', upsert: true },
    );
    assertEquals(error, null, `upload ${f}: ${error?.message}`);
  }
  const submit = await call(s, 'analyze/submit', token, { analysisId: pose.analysisId });
  return { id: pose.analysisId, submit };
}

async function pollStatus(user: SupabaseClient, id: string, timeoutMs = 90_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let status = '';
  while (Date.now() < deadline) {
    const { data, error } = await user.from('analyses').select('status').eq('id', id).single();
    assertEquals(error, null, error?.message);
    status = (data as { status: string }).status;
    if (status === 'succeeded' || status === 'failed' || status === 'rejected') return status;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return status;
}

Deno.test({
  name: 'e2e: anonymous user → prepare → frames → submit → succeeded → get_result (free) → quota → 402',
  ignore: !stack,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const s = stack!;
    const served = await serveFunctions(s);
    const admin = serviceClient(s);
    let uid: string | null = null;
    try {
      const anon = await createAnonymousUser(s);
      uid = anon.userId;
      const token = anon.accessToken;
      const user = createClient(s.url, s.anonKey, {
        auth: NO_SESSION,
        global: { headers: { authorization: `Bearer ${token}` } },
      });

      // profile: birth year (age gate) and the current consent versions
      const { data: cfg } = await user.from('app_config').select('value').eq('key', 'consent_versions').single();
      const versions = (cfg as { value: { pdpl: string; ai: string } }).value;
      const { error: profileError } = await user.from('profiles').update({
        birth_year: 1990,
        age_attested: true,
        pdpl_consent_version: versions.pdpl,
        ai_consent_version: versions.ai,
      }).eq('id', uid);
      assertEquals(profileError, null, profileError?.message);

      // catalog
      const catalog = await call(s, 'analyze/catalog', token);
      assertEquals(catalog.status, 200, catalog.text);
      assert((catalog.json as { skills: unknown[] }).skills.length >= 6);

      // first analysis
      const first = await prepareUploadSubmit(s, user, uid, token);
      assertEquals(first.submit.status, 202, first.submit.text);
      assertEquals(SubmitResponse.parse(first.submit.json).status, 'queued');
      assertEquals(await pollStatus(user, first.id), 'succeeded', `see ${served.log}`);

      const { data: result, error: resultError } = await user.rpc('get_result', { p_analysis_id: first.id });
      assertEquals(resultError, null, resultError?.message);
      const parsed = CoachResultV1.safeParse(result);
      assert(parsed.success, JSON.stringify(parsed.error?.issues.slice(0, 5)));
      assertEquals(parsed.data.access, 'free');
      assertEquals(parsed.data.weaknesses, []);
      assertEquals(parsed.data.plan, []);
      assert(parsed.data.strengths.length <= 1);
      assertEquals(parsed.data.analysisId, first.id);

      // frames are deleted at finalize; the clean track is readable by the owner
      const { data: left } = await admin.storage.from('analysis-inputs').list(`${uid}/${first.id}/frames`);
      assertEquals(left ?? [], []);
      const { data: clean, error: cleanError } = await user.storage.from('analysis-derived')
        .download(`${uid}/${first.id}/pose.clean.json`);
      assertEquals(cleanError, null);
      assert((await clean!.text()).includes('"strokes"'));

      // idempotent re-submit of a finished analysis
      const again = await call(s, 'analyze/submit', token, { analysisId: first.id });
      assertEquals([again.status, (again.json as SubmitResponse).status], [200, 'succeeded']);

      // second free analysis uses the quota
      const second = await prepareUploadSubmit(s, user, uid, token);
      assertEquals(second.submit.status, 202, second.submit.text);
      assertEquals(await pollStatus(user, second.id), 'succeeded');
      const { data: status } = await user.rpc('my_status');
      assertEquals((status as { used: { total: number } }).used.total, 2);
      assertEquals((status as { remaining: number }).remaining, 0);

      // third → 402 without a reservation
      const third = await prepareUploadSubmit(s, user, uid, token);
      assertEquals(third.submit.status, 402, third.submit.text);
      assertEquals((third.submit.json as { code: string }).code, 'quota_exceeded');
      const { data: thirdRow } = await user.from('analyses').select('status').eq('id', third.id).single();
      assertEquals((thirdRow as { status: string }).status, 'prepared');

      // the internal routes refuse callers without their secrets, and accept them with it
      assertEquals((await call(s, 'analyze/run', null, { analysisId: first.id })).status, 401);
      const run = await call(s, 'analyze/run', null, { analysisId: first.id }, {
        'x-internal-secret': served.internalSecret,
      });
      assertEquals(run.status, 202, run.text);
      assertEquals((await call(s, 'cron', null, { task: 'warm' })).status, 401);
      const cron = await call(s, 'cron', null, { task: 'warm' }, { 'x-cron-secret': served.cronSecret });
      assertEquals(cron.status, 202, cron.text);
    } finally {
      if (uid) {
        for (const bucket of ['analysis-inputs', 'analysis-derived']) {
          const { data: folders } = await admin.storage.from(bucket).list(uid);
          for (const f of folders ?? []) {
            const { data: files } = await admin.storage.from(bucket).list(`${uid}/${f.name}`);
            const paths = (files ?? []).map((x) => `${uid}/${f.name}/${x.name}`);
            const { data: frames } = await admin.storage.from(bucket).list(`${uid}/${f.name}/frames`);
            paths.push(...(frames ?? []).map((x) => `${uid}/${f.name}/frames/${x.name}`));
            if (paths.length) await admin.storage.from(bucket).remove(paths);
          }
        }
        await admin.auth.admin.deleteUser(uid);
      }
      await served.stop();
    }
  },
});
