import { assert } from '@std/assert';
import { CoachResultV1, type CoachResultV1 as CoachResult } from '@shared/contracts/index.ts';
import { clone, loadFixture } from '../_helpers/fixtures.ts';

const full = await loadFixture<CoachResult>('results/example_full.json');
const free = await loadFixture<CoachResult>('results/example_free.json');

function issues(doc: unknown): string {
  const r = CoachResultV1.safeParse(doc);
  return r.success ? '' : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' | ');
}

Deno.test('example_full and example_free are valid coach-result.v1', () => {
  assert(issues(full) === '', issues(full));
  assert(issues(free) === '', issues(free));
});

Deno.test('evidence observations contain no digits', () => {
  for (const doc of [full, free]) {
    const obs = [...doc.strengths, ...doc.weaknesses].flatMap((x) => x.evidence.map((e) => e.observation));
    for (const o of obs) assert(!/\d/.test(o), o);
  }
});

Deno.test('free redaction rules', () => {
  const a = clone(free);
  a.checkpoints = full.checkpoints;
  assert(issues(a).includes('no checkpoints'));
  const b = clone(free);
  b.plan = full.plan;
  assert(issues(b).includes('hides weaknesses and plan'));
  const c = clone(full);
  c.locked.plan = 1;
  assert(issues(c).includes('nothing locked'));
});

Deno.test('score rules', () => {
  const a = clone(full);
  a.overall.displayScore = 57;
  assert(issues(a).includes('multiples of 5'));
  const b = clone(full);
  b.overall.partial = true;
  assert(issues(b).includes('partial'));
  const c = clone(full);
  c.subScores = c.subScores.slice(1);
  assert(issues(c).includes('subScores'));
  const d = clone(full);
  (d as { aiGenerated: boolean }).aiGenerated = false;
  assert(issues(d) !== '');
});

Deno.test('rejected result shape', () => {
  const r = clone(free);
  r.status = 'rejected';
  r.rejection = { code: 'not_assessable', tips: ['camera.tip.full_body'] };
  r.hero = null;
  r.strengths = [];
  r.overall = { displayScore: null, level: null, coverage: 0, partial: true, beta: true };
  assert(issues(r) === '', issues(r));
  r.rejection = null;
  assert(issues(r).includes('rejection'));
});
