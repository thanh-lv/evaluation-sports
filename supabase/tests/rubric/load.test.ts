import { assert, assertEquals, assertMatch } from '@std/assert';
import { allRubricSkills, canonicalJson, loadRubric, rubricVersion } from '@shared/rubric/load.ts';
import { isMetricKey, METRIC_CATALOG, METRIC_KEYS, validateMetricParams } from '@shared/engine/metric_catalog.ts';

Deno.test('rubric loads for both sports with drills filtered by sport', () => {
  for (const sport of ['badminton', 'pickleball'] as const) {
    const r = loadRubric(sport);
    assertEquals(r.sport, sport);
    assert(r.skills.length > 0 && r.checkpoints.length > 0 && r.faults.length > 0 && r.drills.length > 0);
    assert(r.drills.every((d) => d.sport === sport));
    for (const c of r.checkpoints) {
      if (c.metric) assertEquals(validateMetricParams(c.metric.fn, c.metric.params), [], c.id);
    }
  }
  assertEquals(allRubricSkills().get('bd.clear_fh'), 'badminton');
});

Deno.test('rubricVersion is a stable sha256 of canonical JSON', async () => {
  const v = await rubricVersion(loadRubric('badminton'));
  assertMatch(v, /^[0-9a-f]{64}$/);
  assertEquals(v, await rubricVersion(loadRubric('badminton')));
  assertEquals(canonicalJson({ b: 1, a: [2, { d: 3, c: null }] }), '{"a":[2,{"c":null,"d":3}],"b":1}');
});

Deno.test('metric catalog is complete and self-consistent', () => {
  assertEquals(METRIC_KEYS.length, 24);
  for (const key of METRIC_KEYS) {
    const def = METRIC_CATALOG[key];
    assertEquals(def.key, key);
    assert(def.phases.length > 0);
    for (const [name, p] of Object.entries(def.params)) {
      assertEquals(validateMetricParams(key, { [name]: p.default }), [], `${key}.${name} default`);
    }
  }
  assert(!isMetricKey('nope'));
  assertEquals(validateMetricParams('kneeFlex', { side: 'lead' }), []);
  assertEquals(validateMetricParams('kneeFlex', { side: 'up' }).length, 1);
  assertEquals(validateMetricParams('kneeFlex', { foo: 1 }).length, 1);
});
