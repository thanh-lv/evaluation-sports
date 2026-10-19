/**
 * End to end without network: pose fixture → prepare → (mock | fixture) Claude → runOnce → postprocess → compose →
 * valid coach-result.v1, through scripts/replay.ts (the same code path as the analyze job's Claude step).
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { CoachResultV1 } from '@shared/contracts/index.ts';
import { DEFAULT_MODEL_ROUTES, mockCoachClient, runCoachAttempt } from '@shared/claude/index.ts';
import { loadRubric } from '@shared/rubric/load.ts';
import { captureLogger } from '@shared/testing/log.ts';
import { GOLDEN_RESULTS, goldenResultText, replayClaude, replayPrepare } from '../../../scripts/replay.ts';
import { loadFixture } from '../_helpers/fixtures.ts';
import { CREATED_AT, framesFor, SYNTHETIC } from './_claude.ts';

const ROOT = new URL('../../../', import.meta.url);

async function preparedOf(name: string) {
  const { out } = replayPrepare(await loadFixture(`pose/${name}.json`));
  if (!out.ok) throw new Error(`${name}: ${out.code}`);
  return out.prepared;
}

Deno.test('replay: every synthetic pose → mock Claude → valid coach-result (VI and EN)', async () => {
  for (const name of SYNTHETIC) {
    const prepared = await preparedOf(name);
    for (const language of ['vi', 'en'] as const) {
      const a = await replayClaude(prepared, { language });
      assertEquals(a.run.outcome.kind, 'ok', name);
      assert(a.composed, name);
      CoachResultV1.parse(a.composed.result);
      assertEquals(a.composed.result.narrativeLanguage, language);
      assertEquals(a.post?.flags, [], `${name}: the mock should need no postprocess fixes`);
    }
  }
});

Deno.test('replay: Claude fixtures (--mock-claude) produce valid results', async () => {
  const cases = [
    ['synthetic_bd_clear_fh_60', 'claude/bd_clear_fh_60.vi.json', 'vi'],
    ['synthetic_pb_dink_60', 'claude/pb_dink_60.en.json', 'en'],
  ] as const;
  for (const [pose, fixture, language] of cases) {
    const a = await replayClaude(await preparedOf(pose), { language, fixture: await loadFixture(fixture) });
    assertEquals(a.run.outcome.kind, 'ok');
    CoachResultV1.parse(a.composed!.result);
    assertEquals(a.composed!.result.status, 'succeeded');
  }
});

Deno.test('golden mock results are in sync (scripts/replay.ts --golden --check)', async () => {
  assertEquals(GOLDEN_RESULTS.length, 2);
  for (const { name, lang } of GOLDEN_RESULTS) {
    const expected = await Deno.readTextFile(new URL(`shared/fixtures/results/replay_${name}.${lang}.json`, ROOT));
    assertEquals(await goldenResultText(name, lang), expected, `${name}.${lang}: run scripts/replay.ts --golden`);
  }
});

Deno.test('mock failure scenarios flow through the attempt pipeline without a result', async () => {
  const prepared = await preparedOf('synthetic_pb_dink_60');
  const rubric = loadRubric(prepared.sport);
  for (
    const [scenario, kind] of [['refusal', 'refusal'], ['max_tokens', 'max_tokens'], [
      'overloaded',
      'retryable',
    ]] as const
  ) {
    const { log, lines } = captureLogger();
    const a = await runCoachAttempt({
      prepared,
      rubric,
      language: 'en',
      route: DEFAULT_MODEL_ROUTES.standard,
      frames: framesFor(prepared),
      kind: 'standard',
      createdAt: CREATED_AT,
      log,
      client: (req) => mockCoachClient({ prepared, rubric, language: 'en', sentFrameIds: req.sentFrameIds }, scenario),
    });
    assertEquals(a.run.outcome.kind, kind);
    assertEquals(a.composed, null);
    assertEquals(lines.filter((l) => l.entry.msg === 'claude_call').length, 1);
  }
});

Deno.test('replay CLI: --mock-claude <fixture> --out writes request.json (images elided) and result.json', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        'run',
        '-A',
        '--config',
        new URL('supabase/functions/deno.json', ROOT).pathname,
        new URL('scripts/replay.ts', ROOT).pathname,
        '--lang',
        'en',
        '--mock', // boolean flags may come before the pose file; --mock-claude wins over --mock
        new URL('shared/fixtures/pose/synthetic_pb_dink_60.json', ROOT).pathname,
        '--mock-claude',
        new URL('shared/fixtures/claude/pb_dink_60.en.json', ROOT).pathname,
        '--out',
        dir,
      ],
      stdout: 'piped',
      stderr: 'piped',
    });
    const res = await cmd.output();
    const stdout = new TextDecoder().decode(res.stdout);
    assertEquals(res.code, 0, new TextDecoder().decode(res.stderr) + stdout);
    assertStringIncludes(stdout, '[claude] claude-sonnet-5-5 → ok');
    const result = CoachResultV1.parse(JSON.parse(await Deno.readTextFile(`${dir}/result.json`)));
    assertEquals(result.hero?.checkpointId, 'pb.ready.PR4');
    const request = await Deno.readTextFile(`${dir}/request.json`);
    assertStringIncludes(request, '"data": "<');
    assertStringIncludes(request, 'Output language: en');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
