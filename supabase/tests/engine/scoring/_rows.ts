/** CheckpointRow factory for scoring tests. */
import type { SubScoreKey } from '@shared/contracts/index.ts';
import type { CheckpointRow } from '@shared/engine/prepared_state.ts';

export function row(over: Partial<CheckpointRow> & { id: string; subscore: SubScoreKey }): CheckpointRow {
  const assess = over.assess ?? 'M';
  const status = over.status ?? (assess === 'V' ? 'visual' : assess === 'N' ? 'not_assessable' : 'measured');
  return {
    assess,
    weight: 1,
    phase: 'contact',
    metricKey: assess === 'M' || assess === 'M~' ? 'wristH' : null,
    unit: 'T',
    status,
    s: status === 'measured' ? 1 : null,
    c: status === 'measured' ? 1 : 0,
    value: null,
    target: [0, 1],
    tol: 1,
    reading: null,
    valueText: '',
    targetText: '',
    perStroke: [],
    joints: [],
    viewFactor: 1,
    velocityBased: false,
    injuryFlag: false,
    validStrokes: status === 'measured' ? 3 : 0,
    ...over,
  };
}

export const EVEN_WEIGHTS = { stance: 20, footwork: 0, swing: 20, contact: 20, follow: 20, recovery: 20 } as const;
