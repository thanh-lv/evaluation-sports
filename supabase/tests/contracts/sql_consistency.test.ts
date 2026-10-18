/**
 * Cross-module consistency between the SQL migrations / seed, the TS contracts, the rubric and DESIGN.md.
 * Pure text checks (no database): the pgTAP suite (supabase/tests/sql/run.sh) covers runtime behaviour, this file
 * catches drift when one side changes an enum, a skill or a seeded limit without the other.
 */
import { assert, assertEquals } from '@std/assert';
import {
  ANALYSIS_HZ,
  ANALYSIS_KINDS,
  ANALYSIS_STATUSES,
  CAMERA_VIEWS,
  CONFIRMED_CAMERA_VIEWS,
  FAILURE_CODES,
  FRAME_MODES,
  HANDEDNESS,
  LANGUAGES,
  LEVELS,
  PREPARE_REJECTION_CODES,
  RESULT_REJECTION_CODES,
  SkillId,
  SPORTS,
  SUBJECTS,
  TIERS,
  UPLOAD_FRAME_IDS,
} from '@shared/contracts/index.ts';
import { CatalogPlan } from '@shared/contracts/api_v1.ts';
import { PreparedAnalysisV1Structure } from '@shared/engine/prepared_state.ts';
import { allRubricSkills } from '@shared/rubric/load.ts';
import { LAUNCH_SKILLS } from '../rubric/_rubric.ts';

const ROOT = new URL('../../../', import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, ROOT));

const MIGRATIONS = [...Deno.readDirSync(new URL('supabase/migrations/', ROOT))]
  .filter((e) => e.isFile && e.name.endsWith('.sql'))
  .map((e) => e.name)
  .sort()
  .map((name) => read(`supabase/migrations/${name}`))
  .join('\n');
const SEED = read('supabase/seed.sql');
const DESIGN = read('docs/DESIGN.md');

/** Body of `create table <name> (` … `);`. */
function tableBody(name: string): string {
  const start = MIGRATIONS.indexOf(`create table ${name} (`);
  assert(start >= 0, `create table ${name} not found in supabase/migrations`);
  const end = MIGRATIONS.indexOf('\n);', start);
  return MIGRATIONS.slice(start, end);
}

/** Values of a `<column> … check (<column> in (…))` constraint, as strings (quotes stripped). */
function checkValues(table: string, column: string): string[] {
  const m = tableBody(table).match(new RegExp(`\\b${column} [^,]*?check \\(${column} in \\(([^)]*)\\)\\)`));
  assert(m, `${table}.${column}: no "check (${column} in (…))" constraint`);
  return m[1].split(',').map((v) => v.trim().replace(/^'(.*)'$/, '$1'));
}

const sorted = (xs: readonly (string | number)[]) => xs.map(String).sort();

Deno.test('analyses / analysis_results / profiles CHECK enums match the TS contracts', () => {
  const cases: Array<[string, string, readonly (string | number)[]]> = [
    ['public.analyses', 'sport', SPORTS],
    ['public.analyses', 'camera_view', CAMERA_VIEWS],
    ['public.analyses', 'view_confirmed', CONFIRMED_CAMERA_VIEWS],
    ['public.analyses', 'subject', SUBJECTS],
    ['public.analyses', 'frame_mode', FRAME_MODES],
    ['public.analyses', 'language', LANGUAGES],
    ['public.analyses', 'handedness', HANDEDNESS],
    ['public.analyses', 'status', ANALYSIS_STATUSES],
    ['public.analyses', 'kind', ANALYSIS_KINDS],
    ['public.analyses', 'analysis_hz', ANALYSIS_HZ],
    ['public.analysis_results', 'sport', SPORTS],
    ['public.analysis_results', 'subject', SUBJECTS],
    ['public.analysis_results', 'level', LEVELS],
    ['public.profiles', 'locale', LANGUAGES],
    ['public.profiles', 'handedness', HANDEDNESS],
    ['public.profiles', 'level', LEVELS],
    ['public.plan_limits', 'tier', TIERS],
    ['public.entitlements', 'tier', TIERS],
    ['public.model_routes', 'kind', ANALYSIS_KINDS],
    ['public.quota_ledger', 'kind', ANALYSIS_KINDS],
    ['public.enabled_skills', 'sport', SPORTS],
  ];
  for (const [table, column, expected] of cases) {
    assertEquals(sorted(checkValues(table, column)), sorted(expected), `${table}.${column}`);
  }
  assertEquals(
    sorted(checkValues('public.plan_limits', 'period_type')),
    sorted(CatalogPlan.shape.periodType.options),
    'plan_limits.period_type vs CatalogPlan.periodType',
  );
});

Deno.test('every failure / rejection code fits analyses.failure_code and skill ids fit the SQL pattern', () => {
  const m = tableBody('public.analyses').match(/failure_code text check \(failure_code ~ '([^']+)'\)/);
  assert(m, 'analyses.failure_code pattern not found');
  const re = new RegExp(m[1]);
  for (const code of [...PREPARE_REJECTION_CODES, ...FAILURE_CODES, ...RESULT_REJECTION_CODES]) {
    assert(re.test(code), `failure_code CHECK rejects ${code}`);
  }
  const skillRe = tableBody('public.analyses').match(/skill text not null check \(skill ~ '([^']+)'\)/);
  assert(skillRe, 'analyses.skill pattern not found');
  for (const id of allRubricSkills().keys()) {
    assert(new RegExp(skillRe[1]).test(id), `analyses.skill CHECK rejects ${id}`);
    assert(SkillId.safeParse(id).success, `SkillId rejects ${id}`);
  }
});

Deno.test('analyses.frame_count admits every upload frame plan', () => {
  const m = tableBody('public.analyses').match(/frame_count smallint [^,]*check \(frame_count between 0 and (\d+)\)/);
  assert(m, 'analyses.frame_count CHECK not found');
  assert(Number(m[1]) >= UPLOAD_FRAME_IDS.length, `frame_count max ${m[1]} < ${UPLOAD_FRAME_IDS.length}`);
});

Deno.test('prepared.v1 header fields stored in analyses columns use values the columns accept', () => {
  const shape = PreparedAnalysisV1Structure.shape;
  // prepared field → analyses column the prepare handler copies it into (upsert_prepared_analysis p_fields).
  const pairs: Array<[readonly (string | number)[], string]> = [
    [shape.sport.options, 'sport'],
    [shape.view.options, 'view_confirmed'],
    [shape.handedness.options, 'handedness'],
    [shape.frameMode.options, 'frame_mode'],
    [shape.analysisHz.options.map((o) => o.value), 'analysis_hz'],
  ];
  for (const [values, column] of pairs) {
    const allowed = new Set(checkValues('public.analyses', column));
    for (const v of values) assert(allowed.has(String(v)), `analyses.${column} rejects prepared value ${v}`);
  }
  const fn = MIGRATIONS.slice(MIGRATIONS.indexOf('function private.upsert_prepared_analysis'));
  for (const column of ['prepared', 'algo_version', 'rubric_version', 'analysis_hz', 'quality', 'view_confirmed']) {
    assert(tableBody('public.analyses').includes(`\n  ${column} `), `analyses.${column} column missing`);
    assert(fn.includes(`${column} = coalesce(f.${column}`), `upsert_prepared_analysis does not store ${column}`);
  }
});

Deno.test('enabled_skills seed covers exactly the rubric skills; launch skills on, deferred off', () => {
  const rows = [...SEED.matchAll(/\('((?:bd|pb)\.[a-z0-9_]+)', '(badminton|pickleball)', (true|false),/g)]
    .map(([, skill, sport, enabled]) => ({ skill, sport, enabled: enabled === 'true' }));
  const rubric = allRubricSkills();
  assertEquals(sorted(rows.map((r) => r.skill)), sorted([...rubric.keys()]), 'seed vs rubric skill ids');
  for (const r of rows) {
    assertEquals(r.sport, rubric.get(r.skill), `${r.skill} sport`);
    assertEquals(r.enabled, (LAUNCH_SKILLS as readonly string[]).includes(r.skill), `${r.skill} enabled flag`);
  }
});

Deno.test('plan_limits seed matches the DESIGN.md §6.5 seed line', () => {
  const design = [
    ...DESIGN.matchAll(/• (free|trial|premium) \((\w+), (\d+), (\d+), (true|false), (\d+), (\d+), /g),
  ].map((m) => m.slice(1, 8).join(','));
  assertEquals(design.length, 3, 'DESIGN plan_limits seed lines not found');
  const seed = [
    ...SEED.matchAll(/\('(free|trial|premium)', '(\w+)', (\d+), (\d+), (true|false), (\d+), (\d+),/g),
  ].map((m) => m.slice(1, 8).join(','));
  assertEquals(seed.sort(), design.sort());
  const free = SEED.match(/\('free',[\s\S]*?'(\{[^']*\})'\)/);
  assert(free);
  assertEquals(JSON.parse(free[1]), { full_report: false, progress: false, player: false, history_full_limit: 3 });
});

Deno.test('model_routes seed matches the DESIGN.md §8.1 table', () => {
  const design = new Map(
    [
      ...DESIGN.matchAll(
        /^\| `(basic|standard)` \|[^|]*\| `([^`]+)` \| \**`(\w+)`\**[^|]*\| (\d+) \| (\d+) s \| ([^|]*)\|$/gm,
      ),
    ].map(([, kind, model, effort, maxTokens, timeoutS, fallbacks]) => [
      kind,
      {
        model,
        effort,
        maxTokens: Number(maxTokens),
        timeoutMs: Number(timeoutS) * 1000,
        fallback: /"default"/.test(fallbacks),
      },
    ]),
  );
  assertEquals([...design.keys()].sort(), ['basic', 'standard'], 'DESIGN §8.1 rows not found');
  const seed = [
    ...SEED.matchAll(/\('(basic|standard)', '([^']+)', '(\w+)', (\d+), (\d+), (null|'default'), '\{([^}]*)\}'\)/g),
  ];
  assertEquals(seed.length, 2, 'seed model_routes rows not found');
  for (const [, kind, model, effort, maxTokens, timeoutMs, fallbacks, betas] of seed) {
    const d = design.get(kind)!;
    assertEquals(
      { model, effort, maxTokens: Number(maxTokens), timeoutMs: Number(timeoutMs), fallback: fallbacks !== 'null' },
      d,
      kind,
    );
    if (d.fallback) assert(betas.includes('server-side-fallback-'), `${kind}: fallbacks need the beta header`);
  }
});

Deno.test('app_config seed carries the DESIGN defaults (D21 age, §8.7 budget)', () => {
  const value = (key: string) => SEED.match(new RegExp(`\\('${key}', '([^']*)'`))?.[1];
  assertEquals(value('min_user_age'), '18');
  assertEquals(value('budget_usd'), '30');
  assertEquals(value('budget_alert_ratio'), '0.7');
  assertEquals(value('budget_hard_cap_mult'), '2');
});
