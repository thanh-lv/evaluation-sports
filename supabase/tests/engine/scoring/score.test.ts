/** Scoring rules (DESIGN.md §6.4, DESIGN-v1.0 §6.4 without hysteresis). */
import { assert, assertAlmostEquals, assertEquals } from '@std/assert';
import {
  aggregateStrokes,
  checkpointConfidence,
  composeScores,
  displayScore,
  levelFor,
  previewSubScores,
  readingOf,
  scoreMetric,
} from '@shared/engine/score.ts';
import { EVEN_WEIGHTS, row } from './_rows.ts';

Deno.test('scoreMetric: 1 inside the band, linear fall-off over tol outside, booleans 1/0', () => {
  assertEquals(scoreMetric(20, [10, 30], 10), 1);
  assertEquals(scoreMetric(10, [10, 30], 10), 1);
  assertAlmostEquals(scoreMetric(35, [10, 30], 10) as number, 0.5, 1e-12);
  assertAlmostEquals(scoreMetric(7, [10, 30], 10) as number, 0.7, 1e-12);
  assertEquals(scoreMetric(50, [10, 30], 10), 0);
  assertEquals(scoreMetric(1000, [150, null], 20), 1);
  assertAlmostEquals(scoreMetric(140, [150, null], 20) as number, 0.5, 1e-12);
  assertAlmostEquals(scoreMetric(0.4, [null, 0.3], 0.2) as number, 0.5, 1e-12);
  assertEquals(scoreMetric(0.31, [null, 0.3], 0), 0, 'tol 0 → hard band');
  assertEquals(scoreMetric(true, true, 0), 1);
  assertEquals(scoreMetric(false, true, 0), 0);
  assertEquals(scoreMetric(false, false, 0), 1);
  assertEquals(scoreMetric(null, [0, 1], 1), null);
});

Deno.test('readingOf: low / high / ok for bands, true / false (met / not met) for booleans', () => {
  assertEquals(readingOf(5, [10, 30]), 'low');
  assertEquals(readingOf(31, [10, 30]), 'high');
  assertEquals(readingOf(10, [10, null]), 'ok');
  assertEquals(readingOf(true, true), 'true');
  assertEquals(readingOf(false, true), 'false');
  assertEquals(readingOf(true, false), 'false');
  assertEquals(readingOf(null, [0, 1]), null);
});

Deno.test('checkpoint confidence: min(1, conf/0.6) × view factor, velocity metrics halved at 30 Hz', () => {
  assertEquals(checkpointConfidence(0.9, 1, false, 30), 1);
  assertAlmostEquals(checkpointConfidence(0.3, 1, false, 60), 0.5, 1e-12);
  assertAlmostEquals(checkpointConfidence(0.9, 0.6, false, 60), 0.6, 1e-12);
  assertAlmostEquals(checkpointConfidence(0.9, 0.6, true, 30), 0.3, 1e-12);
  assertAlmostEquals(checkpointConfidence(0.9, 1, true, 60), 1, 1e-12);
});

Deno.test('aggregateStrokes: median for ≥ 3 strokes, mean with confidence halved for 1–2, mean for booleans', () => {
  const o = { viewFactor: 1, velocityBased: false, hz: 60, boolean: false };
  const three = aggregateStrokes([{ s: 1, conf: 0.9 }, { s: 0, conf: 0.9 }, { s: 0.2, conf: 0.9 }], o);
  assertEquals(three, { s: 0.2, c: 1 });
  const four = aggregateStrokes([{ s: 1, conf: 0.6 }, { s: 0, conf: 0.6 }, { s: 0.2, conf: 0.6 }, {
    s: 0.4,
    conf: 0.6,
  }], o);
  assertAlmostEquals(four!.s, 0.3, 1e-12);
  const two = aggregateStrokes([{ s: 1, conf: 0.9 }, { s: 0, conf: 0.9 }], o);
  assertEquals(two, { s: 0.5, c: 0.5 });
  const bools = aggregateStrokes([{ s: 1, conf: 0.9 }, { s: 1, conf: 0.9 }, { s: 0, conf: 0.9 }, { s: 0, conf: 0.9 }], {
    ...o,
    boolean: true,
  });
  assertEquals(bools!.s, 0.5);
  assertEquals(aggregateStrokes([], o), null);
});

Deno.test('display rounding to 5 and level bands from the raw score (no hysteresis)', () => {
  assertEquals(displayScore(62.5), 65);
  assertEquals(displayScore(62.49), 60);
  assertEquals(displayScore(87.4), 85);
  assertEquals(displayScore(2.4), 0);
  assertEquals(displayScore(99.9), 100);
  assertEquals(levelFor(39.99), 'beginner');
  assertEquals(levelFor(40), 'improving');
  assertEquals(levelFor(59.99), 'improving');
  assertEquals(levelFor(60), 'intermediate');
  assertEquals(levelFor(79.99), 'intermediate');
  assertEquals(levelFor(80), 'advanced');
});

Deno.test('composeScores: sub-score = 100·Σwcs/Σwc, coverage = Σwc/Σw (excluded rows never count)', () => {
  const table = [
    row({ id: 'a', subscore: 'swing', weight: 2, s: 1, c: 1 }),
    row({ id: 'b', subscore: 'swing', weight: 1, s: 0.4, c: 0.5 }),
    row({ id: 'nd', subscore: 'swing', status: 'no_data', s: null, c: 0 }), // lost by tracking: counts, c = 0
    row({ id: 'c', subscore: 'swing', status: 'view_excluded', s: null, c: 0, viewFactor: 0 }), // excluded
    row({ id: 'd', subscore: 'swing', assess: 'N' }), // excluded
  ];
  const out = composeScores(table, [], { weights: EVEN_WEIGHTS });
  const swing = out.subScores.find((s) => s.key === 'swing')!;
  assertAlmostEquals(swing.score as number, (100 * (2 * 1 + 0.5 * 0.4)) / 2.5, 1e-9);
  assertAlmostEquals(swing.coverage, 2.5 / 4, 1e-12);
  assert(swing.shown);
  assertEquals(swing.displayScore, 90);
  const stance = out.subScores.find((s) => s.key === 'stance')!;
  assertEquals([stance.score, stance.shown, stance.coverage], [null, false, 0]);
});

Deno.test('composeScores: V level/4 with c by confidence × view factor; −1 or missing excludes', () => {
  const table = [
    row({ id: 'm', subscore: 'contact', weight: 2, s: 1, c: 1 }),
    row({ id: 'v1', subscore: 'contact', assess: 'V' }),
    row({ id: 'v2', subscore: 'contact', assess: 'V', viewFactor: 0.6 }),
    row({ id: 'v3', subscore: 'contact', assess: 'V' }),
  ];
  const out = composeScores(table, [
    { checkpointId: 'v1', level: 3, confidence: 'high' },
    { checkpointId: 'v2', level: 2, confidence: 'medium' },
    { checkpointId: 'v3', level: -1, confidence: 'high' },
    { checkpointId: 'unknown', level: 4, confidence: 'high' },
  ], { weights: EVEN_WEIGHTS });
  const byId = new Map(out.checkpoints.map((c) => [c.id, c]));
  assertEquals([byId.get('v1')!.s, byId.get('v1')!.c, byId.get('v1')!.visualLevel], [0.75, 1, 3]);
  assertAlmostEquals(byId.get('v2')!.c, 0.42, 1e-12);
  assertEquals([byId.get('v3')!.s, byId.get('v3')!.effectiveWeight], [null, 0]);
  // V weight 1 + 0.42 = 1.42 vs measured 2: share 41.5 % > 35 % → scaled.
  const contact = out.subScores.find((s) => s.key === 'contact')!;
  assert(contact.vScale < 1);
  const v = byId.get('v1')!.effectiveWeight + byId.get('v2')!.effectiveWeight;
  assertAlmostEquals(v / (v + 2), 0.35, 1e-12);
});

Deno.test('composeScores: V share capped at 35 % of the effective weight; V alone cannot score', () => {
  const table = [
    row({ id: 'm', subscore: 'swing', weight: 1, s: 1, c: 1 }),
    row({ id: 'v', subscore: 'swing', assess: 'V', weight: 2 }),
    row({ id: 'vOnly', subscore: 'follow', assess: 'V', weight: 2 }),
  ];
  const out = composeScores(table, [
    { checkpointId: 'v', level: 0, confidence: 'high' },
    { checkpointId: 'vOnly', level: 4, confidence: 'high' },
  ], { weights: EVEN_WEIGHTS });
  const swing = out.subScores.find((s) => s.key === 'swing')!;
  // k·2 = 0.35·(1 + k·2) → V weight 0.5385; score = 100·1/1.5385 = 65.
  assertAlmostEquals(swing.score as number, 65, 1e-9);
  assertAlmostEquals(swing.coverage, (1 + 0.35 / 0.65) / 3, 1e-12);
  const follow = out.subScores.find((s) => s.key === 'follow')!;
  assertEquals([follow.score, follow.shown, follow.coverage], [null, false, 0]);
  // Under the cap nothing changes.
  const small = composeScores(
    [
      row({ id: 'm', subscore: 'swing', weight: 2, s: 1, c: 1 }),
      row({ id: 'v', subscore: 'swing', assess: 'V', weight: 1 }),
    ],
    [{ checkpointId: 'v', level: 2, confidence: 'low' }],
    { weights: EVEN_WEIGHTS },
  );
  const sw = small.subScores.find((s) => s.key === 'swing')!;
  assertEquals(sw.vScale, 1);
  assertAlmostEquals(sw.score as number, (100 * (2 + 0.4 * 0.5)) / 2.4, 1e-9);
});

Deno.test('composeScores: sub-scores below 0.4 coverage are hidden and left out of the overall', () => {
  const table = [
    row({ id: 'a', subscore: 'swing', s: 1, c: 1 }),
    row({ id: 'b', subscore: 'contact', s: 0, c: 0.3 }), // coverage 0.3 → hidden
    row({ id: 'c', subscore: 'stance', s: 0.5, c: 1 }),
    row({ id: 'd', subscore: 'follow', s: 0.5, c: 1 }),
    row({ id: 'e', subscore: 'recovery', s: 0.5, c: 1 }),
  ];
  const out = composeScores(table, [], { weights: EVEN_WEIGHTS });
  const contact = out.subScores.find((s) => s.key === 'contact')!;
  assertEquals([contact.shown, contact.displayScore], [false, null]);
  // Overall over shown subs (equal weights): (100 + 50 + 50 + 50) / 4 = 62.5; coverage (1+0.3+1+1+1)/5 = 0.86.
  assertAlmostEquals(out.overall.coverage, 0.86, 1e-12);
  assertAlmostEquals(out.overall.score as number, 62.5, 1e-9);
  assertEquals([out.overall.displayScore, out.overall.level, out.overall.partial], [65, 'intermediate', false]);
});

Deno.test('composeScores: coverage < 0.5 → partial without a number; < 0.8 → capped at 85', () => {
  const full = (c: number) =>
    (['stance', 'swing', 'contact', 'follow', 'recovery'] as const).map((k) => row({ id: k, subscore: k, s: 1, c }));
  const low = composeScores(full(0.45), [], { weights: EVEN_WEIGHTS });
  assertEquals(low.overall, {
    score: null,
    displayScore: null,
    level: null,
    coverage: 0.45,
    partial: true,
    capped: false,
  });
  const mid = composeScores(full(0.7), [], { weights: EVEN_WEIGHTS });
  assertEquals([mid.overall.score, mid.overall.displayScore, mid.overall.capped], [85, 85, true]);
  assertEquals(mid.overall.level, 'advanced');
  const high = composeScores(full(0.8), [], { weights: EVEN_WEIGHTS });
  assertEquals([high.overall.score, high.overall.displayScore, high.overall.capped], [100, 100, false]);
  // A sub-score with weight 0 (footwork for serves) never affects coverage.
  const serve = composeScores([...full(0.8), row({ id: 'fw', subscore: 'footwork', s: 0, c: 0 })], [], {
    weights: EVEN_WEIGHTS,
  });
  assertEquals(serve.overall.coverage, 0.8);
});

Deno.test('composeScores: overall is skill-weighted and renormalised over the shown sub-scores', () => {
  const weights = { stance: 10, footwork: 15, swing: 30, contact: 20, follow: 10, recovery: 15 };
  const table = [
    row({ id: 'st', subscore: 'stance', s: 1, c: 1 }),
    row({ id: 'fw', subscore: 'footwork', s: 0, c: 0.2 }), // hidden
    row({ id: 'sw', subscore: 'swing', s: 0.5, c: 1 }),
    row({ id: 'co', subscore: 'contact', s: 0.8, c: 1 }),
    row({ id: 'fo', subscore: 'follow', s: 1, c: 1 }),
    row({ id: 're', subscore: 'recovery', s: 0.2, c: 1 }),
  ];
  const out = composeScores(table, [], { weights });
  const expected = (10 * 100 + 30 * 50 + 20 * 80 + 10 * 100 + 15 * 20) / 85;
  assertAlmostEquals(out.overall.score as number, expected, 1e-9);
  assertAlmostEquals(out.overall.coverage, (85 + 15 * 0.2) / 100, 1e-12);
  assertEquals(out.overall.level, levelFor(expected));
});

Deno.test('previewSubScores: measured only (V rows unjudged), rounded', () => {
  const table = [
    row({ id: 'a', subscore: 'swing', s: 0.123456, c: 1 }),
    row({ id: 'v', subscore: 'swing', assess: 'V' }),
  ];
  const p = previewSubScores(table, { weights: EVEN_WEIGHTS });
  const swing = p.subScores.find((s) => s.key === 'swing')!;
  // The unjudged V item is not in Σw yet (it only counts once Claude gives it a level 0..4).
  assertEquals([swing.score, swing.coverage, swing.shown], [12.3, 1, true]);
});

Deno.test('composeScores: V items count in Σw only when judged; −1, missing and view-0 V items are excluded', () => {
  const table = [
    row({ id: 'm', subscore: 'contact', weight: 2, s: 1, c: 1 }),
    row({ id: 'v1', subscore: 'contact', assess: 'V' }),
    row({ id: 'v2', subscore: 'contact', assess: 'V' }),
    row({ id: 'v3', subscore: 'contact', assess: 'V' }),
    row({ id: 'v4', subscore: 'contact', assess: 'V', viewFactor: 0 }),
  ];
  const out = composeScores(table, [
    { checkpointId: 'v1', level: 4, confidence: 'low' },
    { checkpointId: 'v2', level: -1, confidence: 'high' },
    { checkpointId: 'v4', level: 4, confidence: 'high' },
  ], { weights: EVEN_WEIGHTS });
  const contact = out.subScores.find((s) => s.key === 'contact')!;
  // Σw = 2 (m) + 1 (v1); eff = 2 + 0.4 (v1 low, under the 35 % cap).
  assertEquals(contact.vScale, 1);
  assertAlmostEquals(contact.coverage, 2.4 / 3, 1e-12);
  // pose_only: every V forced to −1 → coverage from the measured rows alone.
  const poseOnly = composeScores(
    table,
    table.filter((r) => r.assess === 'V').map((r) => ({
      checkpointId: r.id,
      level: -1,
      confidence: 'high' as const,
    })),
    { weights: EVEN_WEIGHTS },
  );
  assertEquals(poseOnly.subScores.find((s) => s.key === 'contact')!.coverage, 1);
});

Deno.test('composeScores: a recommended-view clip with full confidence is not pushed under the 0.8 cap by view-0 rows', () => {
  // Two measured rows (factor 1) and two rows the view cannot see (factor 0): coverage 1, not 0.5.
  const table = (['stance', 'swing', 'contact', 'follow', 'recovery'] as const).flatMap((k) => [
    row({ id: `${k}1`, subscore: k, s: 1, c: 1 }),
    row({ id: `${k}2`, subscore: k, s: 1, c: 1 }),
    row({ id: `${k}3`, subscore: k, status: 'view_excluded', s: null, c: 0, viewFactor: 0 }),
    row({ id: `${k}4`, subscore: k, status: 'view_excluded', s: null, c: 0, viewFactor: 0 }),
  ]);
  const out = composeScores(table, [], { weights: EVEN_WEIGHTS });
  assertEquals([out.overall.coverage, out.overall.partial, out.overall.capped, out.overall.displayScore], [
    1,
    false,
    false,
    100,
  ]);
});
