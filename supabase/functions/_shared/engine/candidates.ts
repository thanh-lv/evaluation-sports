/**
 * Finding candidates handed to Claude (DESIGN.md §6.4; ranking from DESIGN-v1.0 §6.4). Claude may only pick
 * weaknesses / strengths from these lists (or from its own confident V judgments), so code owns the shortlist.
 * - Weaknesses: measured, s < 0.7 ∧ c ≥ 0.4, ranked by impact = W_sub·w·(1 − s)·c; top 6.
 * - Strengths: measured, s ≥ 0.85 ∧ c ≥ 0.6, ranked by W_sub·w·c; top 6.
 * - Injury-flagged checkpoints never enter either list; when they read as a weakness they become `injury` hits,
 *   which the compose step turns into the fixed `CheckpointDef.safety` note.
 * W_sub is the skill's sub-score weight / 100. Ties break on checkpoint id for determinism.
 */
import type { FaultDef, SkillDef } from '../rubric/types.ts';
import type { Candidates, CheckpointRow, Reading } from './prepared_state.ts';
import { round } from './score.ts';

export const CANDIDATE_CONSTANTS = {
  weakS: 0.7,
  weakC: 0.4,
  strongS: 0.85,
  strongC: 0.6,
  top: 6,
} as const;

export function buildCandidates(
  table: readonly CheckpointRow[],
  skill: Pick<SkillDef, 'weights'>,
  faults: readonly FaultDef[],
): Candidates {
  const K = CANDIDATE_CONSTANTS;
  const measured = table.filter((r) => r.status === 'measured' && r.s !== null);
  const wSub = (r: CheckpointRow) => skill.weights[r.subscore] / 100;
  const byKey = <T extends { checkpointId: string }>(key: (x: T) => number) => (a: T, b: T) =>
    key(b) - key(a) || (a.checkpointId < b.checkpointId ? -1 : a.checkpointId > b.checkpointId ? 1 : 0);

  const weaknesses = measured
    .filter((r) => !r.injuryFlag && (r.s as number) < K.weakS && r.c >= K.weakC)
    .map((r) => ({
      checkpointId: r.id,
      faultId: faultFor(r, faults),
      reading: r.reading,
      impact: round(wSub(r) * r.weight * (1 - (r.s as number)) * r.c, 4),
      s: r.s as number,
      c: r.c,
    }))
    .filter((w) => w.impact > 0)
    .sort(byKey((w) => w.impact))
    .slice(0, K.top);

  const strengths = measured
    .filter((r) => !r.injuryFlag && (r.s as number) >= K.strongS && r.c >= K.strongC)
    .map((r) => ({ checkpointId: r.id, rank: round(wSub(r) * r.weight * r.c, 4), s: r.s as number, c: r.c }))
    .filter((s) => s.rank > 0)
    .sort(byKey((s) => s.rank))
    .slice(0, K.top);

  const injury = measured
    .filter((r) => r.injuryFlag && (r.s as number) < K.weakS && r.c >= K.weakC)
    .map((r) => ({ checkpointId: r.id, s: r.s as number, c: r.c }));

  return { weaknesses, strengths, injury };
}

/**
 * The checkpoint's fault for its reading: `low` / `high` for bands, `false` for booleans (a boolean checkpoint is
 * a weakness only because too few strokes met it, whatever the majority value says). Null when the rubric has no
 * fault for that side.
 */
export function faultFor(row: CheckpointRow, faults: readonly FaultDef[]): string | null {
  const when: Reading | null = typeof row.target === 'boolean' ? 'false' : row.reading;
  if (when !== 'low' && when !== 'high' && when !== 'false') return null;
  const f = faults.find((x) => x.checkpoint === row.id && x.when === when);
  return f ? f.id : null;
}
