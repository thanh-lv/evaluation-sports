/** Candidates (DESIGN.md §6.4) and stroke ranking (§6.2 step 12). */
import { assertEquals } from '@std/assert';
import { buildCandidates, faultFor, weakSide } from '@shared/engine/candidates.ts';
import { rankStrokes, strokeScores } from '@shared/engine/rank.ts';
import type { CheckpointDef, FaultDef } from '@shared/rubric/types.ts';
import { EVEN_WEIGHTS, row } from './_rows.ts';

const fault = (id: string, checkpoint: string, when: FaultDef['when']): FaultDef => ({
  id,
  checkpoint,
  when,
  title: { vi: '', en: '' },
  cue: { vi: '', en: '' },
  why: { vi: '', en: '' },
  drills: ['d'],
  defaultDrill: 'd',
});

/** Catalog plain templates for the given ids: "<id> <lang> <side>". */
const plains = (ids: string[]): Pick<CheckpointDef, 'id' | 'plain'>[] =>
  ids.map((id) => ({
    id,
    plain: {
      vi: { low: `${id} vi low`, high: `${id} vi high`, ok: `${id} vi ok` },
      en: { low: `${id} en low`, high: `${id} en high`, ok: `${id} en ok` },
    },
  }));
const ids = (rows: { id: string }[]) => plains(rows.map((r) => r.id));

Deno.test('weakness candidates: s < 0.7 ∧ c ≥ 0.4, by impact W_sub·w·(1−s)·c, top 6, fault by reading', () => {
  const weights = { ...EVEN_WEIGHTS, swing: 40, stance: 0 };
  const table = [
    row({ id: 'a', subscore: 'swing', weight: 2, s: 0.5, c: 1, reading: 'low' }), // .4·2·.5 = 0.4
    row({ id: 'b', subscore: 'contact', weight: 1, s: 0, c: 0.5, reading: 'high' }), // .2·1·1·.5 = 0.1
    row({ id: 'c', subscore: 'contact', weight: 1, s: 0.69, c: 0.4 }), // kept (boundary)
    row({ id: 'd', subscore: 'contact', weight: 1, s: 0.7, c: 1 }), // not a weakness
    row({ id: 'e', subscore: 'contact', weight: 1, s: 0, c: 0.39 }), // too unsure
    row({ id: 'f', subscore: 'stance', weight: 1, s: 0, c: 1 }), // W_sub 0 → impact 0, dropped
    row({ id: 'v', subscore: 'contact', assess: 'V' }), // V never a candidate before Claude
    row({ id: 'inj', subscore: 'follow', s: 0, c: 1, injuryFlag: true }),
  ];
  const faults = [fault('a.low', 'a', 'low'), fault('a.high', 'a', 'high'), fault('b.low', 'b', 'low')];
  const out = buildCandidates(table, { weights }, faults, ids(table));
  assertEquals(out.weaknesses.map((w) => w.checkpointId), ['a', 'b', 'c']);
  assertEquals(out.weaknesses.map((w) => w.faultId), ['a.low', null, null]);
  assertEquals(out.weaknesses[0].impact, 0.4);
  assertEquals(out.injury, [{ checkpointId: 'inj', s: 0, c: 1 }]);
  const many = Array.from({ length: 9 }, (_, i) => row({ id: `w${i}`, subscore: 'swing', s: i / 20, c: 1 }));
  const top = buildCandidates(many, { weights }, [], ids(many));
  assertEquals(top.weaknesses.length, 6);
  assertEquals(top.weaknesses[0].checkpointId, 'w0');
});

Deno.test('strength candidates: s ≥ 0.85 ∧ c ≥ 0.6, by W_sub·w·c, ties by id, injury rows excluded', () => {
  const table = [
    row({ id: 'z', subscore: 'swing', weight: 1, s: 0.85, c: 0.6 }),
    row({ id: 'y', subscore: 'swing', weight: 2, s: 1, c: 1 }),
    row({ id: 'x', subscore: 'swing', weight: 2, s: 1, c: 1 }),
    row({ id: 'w', subscore: 'swing', weight: 2, s: 0.84, c: 1 }),
    row({ id: 'u', subscore: 'swing', weight: 2, s: 1, c: 0.59 }),
    row({ id: 'inj', subscore: 'swing', weight: 2, s: 1, c: 1, injuryFlag: true }),
  ];
  const out = buildCandidates(table, { weights: EVEN_WEIGHTS }, [], ids(table));
  assertEquals(out.strengths.map((s) => s.checkpointId), ['x', 'y', 'z']);
  assertEquals(out.strengths[0].rank, 0.4);
});

Deno.test('candidates carry the side they stand for and its catalog plain template', () => {
  const ps = (strokeId: number, value: number) => ({ strokeId, value, s: 0, c: 1, used: true });
  const table = [
    row({ id: 'lo', subscore: 'swing', s: 0.2, c: 1, reading: 'low', target: [1, 2] }),
    row({ id: 'hi', subscore: 'swing', s: 0.2, c: 1, reading: 'high', target: [1, 2] }),
    // Boolean met by 2/4 strokes: majority reads `true`, but as a weakness it stands for the failed side.
    row({ id: 'b', subscore: 'swing', s: 0.5, c: 1, reading: 'true', target: true, value: true }),
    // Median inside a two-sided band while the strokes miss on both sides: the side most strokes missed.
    row({
      id: 'mix',
      subscore: 'swing',
      s: 0.3,
      c: 1,
      reading: 'ok',
      target: [1, 2],
      perStroke: [ps(1, 3), ps(2, 1.5), ps(3, 3.5), ps(4, 0.5)],
    }),
    row({ id: 'good', subscore: 'contact', s: 1, c: 1, reading: 'ok', target: [1, 2] }),
  ];
  const out = buildCandidates(table, { weights: EVEN_WEIGHTS }, [fault('mix.high', 'mix', 'high')], ids(table));
  const w = new Map(out.weaknesses.map((x) => [x.checkpointId, x]));
  assertEquals(w.get('lo')!.plain, { vi: 'lo vi low', en: 'lo en low' });
  assertEquals(w.get('hi')!.plain, { vi: 'hi vi high', en: 'hi en high' });
  assertEquals([w.get('b')!.reading, w.get('b')!.plain.en], ['false', 'b en low']);
  assertEquals([w.get('mix')!.reading, w.get('mix')!.faultId, w.get('mix')!.plain.en], [
    'high',
    'mix.high',
    'mix en high',
  ]);
  assertEquals(out.strengths.map((x) => [x.checkpointId, x.plain.vi]), [['good', 'good vi ok']]);
  assertEquals(weakSide(row({ id: 'n', subscore: 'swing', reading: 'ok', target: [1, 2] })), 'low');
});

Deno.test('buildCandidates throws on a candidate checkpoint missing from the rubric', () => {
  const table = [row({ id: 'missing', subscore: 'swing', s: 0, c: 1, reading: 'low' })];
  let threw = false;
  try {
    buildCandidates(table, { weights: EVEN_WEIGHTS }, [], []);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test('faultFor: booleans always map to the `false` fault', () => {
  const faults = [fault('h.false', 'h', 'false')];
  assertEquals(
    faultFor(row({ id: 'h', subscore: 'footwork', target: true, reading: 'true', s: 0.5 }), faults),
    'h.false',
  );
  assertEquals(faultFor(row({ id: 'h', subscore: 'footwork', target: [0, 1], reading: 'ok' }), faults), null);
});

Deno.test('strokeScores: Σ w·c·s / Σ w·c of each stroke over measured rows', () => {
  const ps = (s: number | null, c: number, id: number) => ({ strokeId: id, value: 0, s, c, used: true });
  const table = [
    row({ id: 'a', subscore: 'swing', weight: 2, perStroke: [ps(1, 1, 1), ps(0, 1, 2)] }),
    row({ id: 'b', subscore: 'swing', weight: 1, perStroke: [ps(0, 0.5, 1), ps(null, 0, 2)] }),
    row({ id: 'v', subscore: 'swing', assess: 'V', perStroke: [ps(1, 1, 1)] }),
  ];
  const out = strokeScores(table, [1, 2, 3]);
  assertEquals(out.get(1), 0.8);
  assertEquals(out.get(2), 0);
  assertEquals(out.get(3), null);
});

Deno.test('rankStrokes: best/worst among non-excluded strokes with quality ≥ 0.6', () => {
  const s = (id: number, score: number | null, quality = 0.9, excluded = false) => ({ id, score, quality, excluded });
  assertEquals(rankStrokes([s(1, 0.5), s(2, 0.9), s(3, 0.2), s(4, 0.95, 0.5)]), { best: 2, worst: 3 });
  assertEquals(rankStrokes([s(1, 0.5), s(2, 0.9, 0.9, true), s(3, 0.2)]), { best: 1, worst: 3 });
  // One eligible stroke: best only (4 + 1 frames).
  assertEquals(rankStrokes([s(1, 0.5), s(2, 0.9, 0.3)]), { best: 1, worst: null });
  // Nobody passes the quality gate: rank the non-excluded strokes anyway.
  assertEquals(rankStrokes([s(1, 0.5, 0.4), s(2, 0.9, 0.5)]), { best: 2, worst: 1 });
  // Ties: higher quality, then lower id.
  assertEquals(rankStrokes([s(3, 0.5, 0.8), s(1, 0.5, 0.8), s(2, 0.5, 0.9)]), { best: 2, worst: 3 });
  // Unscored strokes rank below scored ones.
  assertEquals(rankStrokes([s(1, null, 1), s(2, 0.1, 0.7)]), { best: 2, worst: 1 });
  assertEquals(rankStrokes([s(1, 0.5, 0.9, true)]), { best: null, worst: null });
});
