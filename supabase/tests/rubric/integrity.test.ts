/**
 * Structural and cross-reference integrity of the rubric (DESIGN.md §6.3 integrity list, DESIGN-v1.0 §6.3).
 * The Zod parse in loadRubric already checks field shapes; these tests check what Zod cannot.
 */
import { assert, assertEquals } from '@std/assert';
import { SPORT_PREFIX, STROKE_PHASES, SUB_SCORE_KEYS } from '@shared/contracts/common.ts';
import { METRIC_CATALOG, validateMetricParams } from '@shared/engine/metric_catalog.ts';
import { loadRubric } from '@shared/rubric/load.ts';
import drillsJson from '@shared/rubric/drills.json' with { type: 'json' };
import { bundles } from './_rubric.ts';

const allIds = () =>
  bundles().flatMap((r) => [
    ...r.skills.map((s) => s.id),
    ...r.checkpoints.map((c) => c.id),
    ...r.faults.map((f) => f.id),
  ]).concat(drillsJson.drills.map((d) => d.id));

Deno.test('every id is unique across both sports and the drill library', () => {
  const ids = allIds();
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assertEquals(dupes, []);
});

Deno.test('ids are prefixed by sport and by their skill / shared group', () => {
  for (const r of bundles()) {
    const p = SPORT_PREFIX[r.sport];
    for (const s of r.skills) assert(new RegExp(`^${p}\\.[a-z0-9_]+$`).test(s.id), s.id);
    for (const c of r.checkpoints) {
      const m = c.id.match(/^([a-z]{2})\.([a-z0-9_]+)\.([A-Z]{1,2}\d{1,2})$/);
      assert(m, `${c.id}: expected <sport>.<group>.<CODE>`);
      assertEquals(m[1], p, c.id);
      const group = `${m[1]}.${m[2]}`;
      const shared = m[2] === 'ready' || m[2] === 'split';
      assert(shared || c.skills.includes(group), `${c.id}: group ${group} must be one of its skills`);
    }
    for (const f of r.faults) {
      const group = f.checkpoint.split('.').slice(0, 2).join('.');
      assert(new RegExp(`^${group.replace('.', '\\.')}\\.[a-z0-9_]+$`).test(f.id), `${f.id} should start ${group}.`);
    }
    for (const d of r.drills) assert(new RegExp(`^${p}\\.drill\\.[a-z0-9_]+$`).test(d.id), d.id);
  }
});

Deno.test('skill weights cover the six sub-scores and sum to 100', () => {
  for (const r of bundles()) {
    for (const s of r.skills) {
      assertEquals(Object.keys(s.weights).sort(), [...SUB_SCORE_KEYS].sort(), s.id);
      assertEquals(Object.values(s.weights).reduce((a, b) => a + b, 0), 100, s.id);
    }
  }
});

Deno.test('skill ↔ checkpoint membership is symmetric and every reference resolves', () => {
  for (const r of bundles()) {
    const skills = new Map(r.skills.map((s) => [s.id, s]));
    const cps = new Map(r.checkpoints.map((c) => [c.id, c]));
    for (const s of r.skills) {
      assertEquals(new Set(s.checkpoints).size, s.checkpoints.length, `${s.id} lists a checkpoint twice`);
      for (const id of s.checkpoints) {
        assert(cps.get(id)?.skills.includes(s.id), `${s.id} lists ${id}, which does not list the skill back`);
      }
    }
    for (const c of r.checkpoints) {
      assert(c.skills.length > 0, `${c.id} belongs to no skill`);
      for (const id of c.skills) assert(skills.get(id)?.checkpoints.includes(c.id), `${c.id} → ${id} not mirrored`);
    }
  }
});

Deno.test('checkpoint sub-score is valid and carries weight for every skill that uses it', () => {
  for (const r of bundles()) {
    const skills = new Map(r.skills.map((s) => [s.id, s]));
    for (const c of r.checkpoints) {
      assert((SUB_SCORE_KEYS as readonly string[]).includes(c.subscore), c.id);
      for (const id of c.skills) {
        assert(skills.get(id)!.weights[c.subscore] > 0, `${c.id} scores ${c.subscore}, which ${id} weights 0`);
      }
    }
  }
});

Deno.test('measured checkpoints reference a registered metric with valid params, phase, unit and target', () => {
  for (const r of bundles()) {
    for (const c of r.checkpoints) {
      const measured = c.assess === 'M' || c.assess === 'M~';
      assertEquals(Boolean(c.metric), measured, `${c.id}: metric iff M / M~`);
      if (!c.metric) continue;
      const def = METRIC_CATALOG[c.metric.fn];
      assert(def, `${c.id}: unknown metric ${c.metric.fn}`);
      assertEquals(validateMetricParams(c.metric.fn, c.metric.params), [], c.id);
      assert(def.phases.includes(c.phase), `${c.id}: ${c.metric.fn} cannot be read at ${c.phase}`);
      assertEquals(c.metric.unit, def.unit, `${c.id}: unit`);
      assertEquals(c.velocityBased, def.velocityBased, `${c.id}: velocityBased must follow the metric`);
      if (def.kind === 'number') {
        assert(Array.isArray(c.metric.target), `${c.id}: numeric metric needs a [lo, hi] band`);
        const [lo, hi] = c.metric.target;
        assert(lo !== null || hi !== null, `${c.id}: band open on both sides`);
        if (lo !== null && hi !== null) assert(lo < hi, `${c.id}: lo < hi`);
        assert(c.metric.tol > 0, `${c.id}: tol > 0`);
      } else {
        assertEquals(c.metric.target, true, `${c.id}: boolean/event metrics expect true`);
      }
      // A checkpoint may trust a view less than the metric registry, never more (0 stays 0).
      for (const v of ['S', 'B', 'D'] as const) {
        assert(c.views[v] <= def.views[v], `${c.id}: view ${v} factor ${c.views[v]} > metric's ${def.views[v]}`);
      }
      assert(Object.values(c.views).some((f) => f > 0), `${c.id}: not assessable from any view`);
    }
  }
});

Deno.test('baseErr dir=forward is a side-view displacement: excluded in behind / front views', () => {
  let forward = 0;
  for (const r of bundles()) {
    for (const c of r.checkpoints) {
      if (c.metric?.fn !== 'baseErr' || c.metric.params?.dir !== 'forward') continue;
      forward++;
      assertEquals(c.views.B, 0, `${c.id}: forward motion is along the camera axis in B/F views`);
      assert(Array.isArray(c.metric.target) && c.metric.target[0] !== null, `${c.id}: needs a lower bound`);
    }
  }
  // "Move up after the shot" checkpoints must not pass when the player backs off (pb.drop3.TD7, pb.return.RT6).
  assertEquals(forward, 2);
});

Deno.test('V checkpoints have 5 anchors and a key-frame phase; N checkpoints carry nothing scorable', () => {
  for (const r of bundles()) {
    for (const c of r.checkpoints) {
      if (c.assess === 'V') {
        assertEquals(c.vAnchors?.length, 5, c.id);
        assert(c.vAnchors!.every((a) => a.trim().length > 0), c.id);
        assert((STROKE_PHASES as readonly string[]).includes(c.phase), `${c.id}: V phase must map to a key frame`);
        assertEquals(c.velocityBased, false, c.id);
      } else {
        assertEquals(c.vAnchors, undefined, `${c.id}: anchors only on V`);
      }
      if (c.assess === 'N') {
        assertEquals(c.faults, [], `${c.id}: N checkpoints have no faults`);
        assertEquals(c.injuryFlag, undefined, c.id);
      } else {
        assert(c.faults.length > 0, `${c.id}: every scorable checkpoint needs a fault (and so a drill)`);
      }
    }
  }
});

Deno.test('faults: ≥1 drill of the same sport, valid defaultDrill, consistent checkpoint and trigger side', () => {
  for (const r of bundles()) {
    const cps = new Map(r.checkpoints.map((c) => [c.id, c]));
    const drills = new Set(r.drills.map((d) => d.id));
    for (const f of r.faults) {
      const c = cps.get(f.checkpoint);
      assert(c, `${f.id}: unknown checkpoint ${f.checkpoint}`);
      assert(c.faults.includes(f.id), `${f.id} not listed by ${c.id}`);
      assert(f.drills.length >= 1 && f.drills.length <= 3, `${f.id}: 1–3 drills`);
      assertEquals(new Set(f.drills).size, f.drills.length, f.id);
      for (const d of f.drills) assert(drills.has(d), `${f.id}: drill ${d} missing for ${r.sport}`);
      assert(f.drills.includes(f.defaultDrill), `${f.id}: defaultDrill must be one of drills`);
      const t = c.metric?.target;
      if (c.assess === 'V') assertEquals(f.when, 'low', `${f.id}: V faults trigger on a low level`);
      else if (typeof t === 'boolean') assertEquals(f.when, 'false', f.id);
      else if (t) {
        assert(f.when !== 'false', f.id);
        assert(t[f.when === 'low' ? 0 : 1] !== null, `${f.id}: band has no ${f.when} bound`);
      }
    }
    for (const c of r.checkpoints) for (const id of c.faults) assert(r.faults.some((f) => f.id === id), id);
  }
});

Deno.test('drill library: doses, step pairs, and every drill is used by some fault', () => {
  const used = new Set(bundles().flatMap((r) => r.faults.flatMap((f) => f.drills)));
  for (const d of drillsJson.drills) {
    assert(used.has(d.id), `${d.id} is never prescribed`);
    assert((d.dose as { reps?: number; seconds?: number }).reps || (d.dose as { seconds?: number }).seconds, d.id);
    assert(d.steps.vi.length >= 2, `${d.id}: at least two steps`);
    assertEquals(d.steps.vi.length, d.steps.en.length, `${d.id}: vi/en step count`);
  }
  // DESIGN.md §6.3: about 30 drills; allow headroom for the deferred skills.
  assert(drillsJson.drills.length >= 25 && drillsJson.drills.length <= 45, `${drillsJson.drills.length} drills`);
});

Deno.test('injury flags carry a fixed safety note; key checkpoints (DESIGN-v1.0 §6.3) have weight 2', () => {
  const flagged: string[] = [];
  for (const r of bundles()) {
    for (const c of r.checkpoints) {
      assertEquals(Boolean(c.injuryFlag), Boolean(c.safety), `${c.id}: injuryFlag ⇔ safety`);
      if (c.injuryFlag) flagged.push(c.id);
    }
  }
  // Equivalents of v1.0 FW4 (lunge knee), SM7 (landing), PM5 (backward lean / backpedal).
  assertEquals(flagged.sort(), ['bd.net_shot.NS6', 'bd.smash.SM7', 'pb.volley.VO7']);

  const key = [
    'bd.clear_fh.C1',
    'bd.clear_fh.C3',
    'bd.clear_fh.C5',
    'bd.net_shot.NS2',
    'pb.return.RT6',
    'pb.dink.DK2',
    'pb.dink.DK3',
    'pb.ready.PR4',
    'pb.volley.VO1',
  ];
  const weights = new Map(bundles().flatMap((r) => r.checkpoints.map((c) => [c.id, c.weight] as const)));
  for (const id of key) assertEquals(weights.get(id), 2, id);
  assertEquals([...weights].filter(([, w]) => w === 2).map(([id]) => id).sort(), key.sort());
});

Deno.test('bundle drills are exactly the sport-prefixed drills of drills.json', () => {
  for (const sport of ['badminton', 'pickleball'] as const) {
    const ids = loadRubric(sport).drills.map((d) => d.id);
    assert(ids.length > 0);
    assert(ids.every((id) => id.startsWith(`${SPORT_PREFIX[sport]}.drill.`)), sport);
  }
});
