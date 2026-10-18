/** Skill-level rubric checks: DESIGN.md §2.1 scope and views, §6.2 segmentation constants, coverage per view. */
import { assert, assertEquals } from '@std/assert';
import { SUB_SCORE_KEYS, viewFactorColumn } from '@shared/contracts/common.ts';
import { allRubricSkills } from '@shared/rubric/load.ts';
import type { RubricBundle, SkillDef } from '@shared/rubric/types.ts';
import { bundles, DEFERRED_SKILLS, LAUNCH_SKILLS } from './_rubric.ts';

const skillById = (): Map<string, [SkillDef, RubricBundle]> =>
  new Map(bundles().flatMap((r) => r.skills.map((s) => [s.id, [s, r]] as const)));

Deno.test('the rubric holds exactly the 6 launch + 6 deferred skills', () => {
  assertEquals([...allRubricSkills().keys()].sort(), [...LAUNCH_SKILLS, ...DEFERRED_SKILLS].sort());
});

Deno.test('segmentation constants match DESIGN.md §6.2 (v1.1) and DESIGN-v1.0 §6.2 for deferred skills', () => {
  const expected: Record<string, [number, number]> = {
    'bd.clear_fh': [4, 0.8],
    'bd.smash': [4, 0.8],
    'bd.serve_low': [1.2, 2.0],
    'pb.serve': [2, 2.0],
    'pb.dink': [1.2, 0.8],
    'pb.drop3': [1.5, 1.0],
    'bd.net_shot': [1.2, 0.8],
    'bd.lift': [2, 0.8],
    'bd.serve_high': [3, 2.0],
    'pb.return': [2, 1.0],
    'pb.drive': [3, 1.0],
    'pb.volley': [1.5, 0.8],
  };
  for (const [id, [s]] of skillById()) assertEquals([s.vmin, s.nms], expected[id], id);
});

Deno.test('launch skills: views per DESIGN.md §2.1, contact offset present, serves are solo', () => {
  const views: Record<string, [string[], string[]]> = {
    'bd.clear_fh': [['D'], ['D', 'B', 'S']],
    'bd.smash': [['D'], ['D', 'B', 'S']],
    'bd.serve_low': [['S'], ['S', 'D']],
    'pb.serve': [['S'], ['S', 'D']],
    'pb.dink': [['S'], ['S', 'D']],
    'pb.drop3': [['S'], ['S', 'D', 'B']],
  };
  const all = skillById();
  for (const id of LAUNCH_SKILLS) {
    const [s] = all.get(id)!;
    assertEquals([s.views.recommended, s.views.allowed], views[id], id);
    assert(Number.isFinite(s.contactOffsetMs), id);
  }
  for (const [id, [s]] of all) {
    assert(s.views.recommended.length > 0, `${id}: needs a recommended view`);
    assert(s.views.recommended.every((v) => s.views.allowed.includes(v)), `${id}: recommended ⊆ allowed`);
    assertEquals(s.solo, /\.serve/.test(id), `${id}: solo exactly for serves`);
  }
});

Deno.test('every weighted sub-score has a measured checkpoint, assessable from each recommended view', () => {
  for (const [id, [s, r]] of skillById()) {
    const cps = r.checkpoints.filter((c) => s.checkpoints.includes(c.id));
    for (const key of SUB_SCORE_KEYS) {
      if (s.weights[key] === 0) continue;
      const measured = cps.filter((c) => c.subscore === key && (c.assess === 'M' || c.assess === 'M~'));
      assert(measured.length > 0, `${id}: no measured checkpoint for ${key}`);
      for (const view of s.views.recommended) {
        const { column } = viewFactorColumn(view);
        assert(measured.some((c) => c.views[column] > 0), `${id}: ${key} not measurable from ${view}`);
      }
    }
  }
});

Deno.test('ready-stance checkpoints are shared by the rally skills; split step by every skill that moves', () => {
  for (const [id, [s]] of skillById()) {
    const sport = id.slice(0, 2);
    const hasReady = s.checkpoints.some((c) => c.startsWith(`${sport}.ready.`));
    const hasSplit = s.checkpoints.some((c) => c.startsWith(`${sport}.split.`));
    // Serves have their own setup checkpoints and no footwork sub-score (weight 0).
    assertEquals(hasReady, s.weights.footwork > 0, `${id}: ready`);
    assertEquals(hasSplit, s.weights.footwork > 0, `${id}: split`);
  }
});
