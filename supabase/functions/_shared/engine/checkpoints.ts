/**
 * Builds the checkpoint table (DESIGN.md §6.2 steps 10–11, §6.4): every checkpoint of the skill, evaluated per
 * stroke with the metric registry and aggregated over the valid strokes.
 *
 * Valid stroke for a checkpoint: not excluded, value present and stroke quality ≥ MIN_STROKE_QUALITY. If no included
 * stroke reaches the quality gate the gate is dropped (better a low-confidence number than none; the confidence of
 * such strokes is already low).
 * V checkpoints are listed with status `visual` (Claude judges them later), N with `not_assessable`.
 */
import { type ConfirmedCameraView, type Joint, viewFactorColumn } from '../contracts/common.ts';
import type { CheckpointDef, MetricSpec, SkillDef } from '../rubric/types.ts';
import { METRIC_CATALOG } from './metric_catalog.ts';
import { evaluateMetric, type MetricContext } from './metrics.ts';
import type { CheckpointRow, PerStrokeMetric } from './prepared_state.ts';
import { aggregateStrokes, checkpointConfidence, readingOf, round, scoreMetric } from './score.ts';
import type { AnalysisHz, StrokePhases } from './types.ts';

/** Strokes below this quality do not enter the aggregates (and are not ranked), DESIGN.md §6.2 step 12. */
export const MIN_STROKE_QUALITY = 0.6;

export interface CheckpointEvalInput {
  skill: SkillDef;
  /** All checkpoints of the sport (looked up by id). */
  checkpoints: readonly CheckpointDef[];
  ctx: MetricContext;
  phases: readonly StrokePhases[];
  hz: AnalysisHz;
  view: ConfirmedCameraView;
  /** Stroke id → quality 0..1. */
  quality: ReadonlyMap<number, number>;
  excluded: ReadonlySet<number>;
}

/** Evaluates every checkpoint of the skill, in the skill's checkpoint order. */
export function evaluateCheckpoints(input: CheckpointEvalInput): CheckpointRow[] {
  const { skill, ctx, phases, hz, view, quality, excluded } = input;
  const defs = new Map(input.checkpoints.map((c) => [c.id, c]));
  const included = phases.filter((p) => !excluded.has(p.strokeId));
  const gate = included.some((p) => (quality.get(p.strokeId) ?? 0) >= MIN_STROKE_QUALITY);
  const usable = (id: number) => !excluded.has(id) && (!gate || (quality.get(id) ?? 0) >= MIN_STROKE_QUALITY);
  const column = viewFactorColumn(view).column;

  return skill.checkpoints.map((id) => {
    const def = defs.get(id);
    if (!def) throw new Error(`rubric: skill ${skill.id} lists unknown checkpoint ${id}`);
    const viewFactor = def.views[column];
    const metric = def.metric;
    const velocityBased = def.velocityBased || (metric ? METRIC_CATALOG[metric.fn].velocityBased : false);
    const base: Omit<CheckpointRow, 'status' | 's' | 'c' | 'value' | 'reading' | 'valueText' | 'perStroke'> = {
      id: def.id,
      subscore: def.subscore,
      assess: def.assess,
      weight: def.weight,
      phase: def.phase,
      metricKey: metric?.fn ?? null,
      unit: metric?.unit ?? null,
      target: metric?.target ?? null,
      tol: metric ? metric.tol : null,
      targetText: metric ? targetText(metric) : '',
      joints: mirrorJoints(def.joints, ctx.handedness === 'left'),
      viewFactor,
      velocityBased,
      injuryFlag: def.injuryFlag === true,
      validStrokes: 0,
    };
    const empty = { s: null, c: 0, value: null, reading: null, valueText: '', perStroke: [] as PerStrokeMetric[] };
    if (def.assess === 'N') return { ...base, ...empty, status: 'not_assessable' as const };
    if (def.assess === 'V' || !metric) return { ...base, ...empty, status: 'visual' as const };

    // Per-stroke evaluation; `jointConf` (the raw mean joint confidence) feeds the aggregate confidence.
    const evals = phases.map((p) => {
      const r = evaluateMetric(metric.fn, metric.params, ctx, p, def.phase);
      const s = scoreMetric(r.value, metric.target, metric.tol);
      const row: PerStrokeMetric = {
        strokeId: p.strokeId,
        value: typeof r.value === 'number' ? round(r.value, 4) : r.value,
        s: s === null ? null : round(s, 4),
        c: round(checkpointConfidence(r.value === null ? 0 : r.conf, viewFactor, velocityBased, hz), 4),
        used: s !== null && viewFactor > 0 && usable(p.strokeId),
      };
      return { row, jointConf: r.conf };
    });
    const valid = evals.filter((e) => e.row.used);
    const clean = evals.map((e) => e.row);
    if (viewFactor === 0) return { ...base, ...empty, perStroke: clean, status: 'view_excluded' as const };
    const isBool = typeof metric.target === 'boolean';
    const agg = aggregateStrokes(valid.map((e) => ({ s: e.row.s as number, conf: e.jointConf })), {
      viewFactor,
      velocityBased,
      hz,
      boolean: isBool,
    });
    if (!agg) return { ...base, ...empty, perStroke: clean, status: 'no_data' as const };
    const values = valid.map((e) => e.row.value as number | boolean);
    const value = aggregateValue(values, isBool);
    return {
      ...base,
      status: 'measured' as const,
      s: round(agg.s, 4),
      c: round(agg.c, 4),
      value: typeof value === 'number' ? round(value, 4) : value,
      reading: readingOf(value, metric.target),
      valueText: valueText(metric, values, value),
      perStroke: clean,
      validStrokes: valid.length,
    };
  });
}

/** Median of numbers (mean with 1–2, matching the s aggregate); majority for booleans (ties → true). */
function aggregateValue(values: (number | boolean)[], isBool: boolean): number | boolean {
  if (isBool) {
    const t = values.filter((v) => v === true || (typeof v === 'number' && v !== 0)).length;
    return t * 2 >= values.length;
  }
  const nums = (values as number[]).slice().sort((a, b) => a - b);
  const n = nums.length;
  if (n <= 2) return nums.reduce((a, b) => a + b, 0) / n;
  return n % 2 ? nums[(n - 1) / 2] : (nums[n / 2 - 1] + nums[n / 2]) / 2;
}

/** Number formatting per rubric unit (language-neutral). */
export function formatValue(v: number, unit: string): string {
  switch (unit) {
    case 'deg':
      return `${Math.round(v)}°`;
    case 'T':
      return `${v.toFixed(2)} T`;
    case 'T/s':
      return `${v.toFixed(1)} T/s`;
    case 'ratio':
      return v.toFixed(2);
    default:
      return `${Number(v.toFixed(2))}${unit ? ` ${unit}` : ''}`;
  }
}

function valueText(metric: MetricSpec, values: (number | boolean)[], agg: number | boolean): string {
  if (typeof metric.target === 'boolean') {
    const t = values.filter((v) => v === true).length;
    return `${t}/${values.length}`;
  }
  return formatValue(agg as number, metric.unit);
}

/** "10–30°", "≥ 150°", "≤ 0.30 T", "✓" / "✗" for booleans. */
export function targetText(metric: MetricSpec): string {
  const t = metric.target;
  if (typeof t === 'boolean') return t ? '✓' : '✗';
  const [lo, hi] = t;
  if (lo !== null && hi !== null) {
    const a = formatValue(lo, metric.unit), b = formatValue(hi, metric.unit);
    // "10°–30°" reads worse than "10–30°": share the unit suffix when both ends carry the same one.
    const suffix = unitSuffix(metric.unit);
    return suffix && a.endsWith(suffix) && b.endsWith(suffix) ? `${a.slice(0, -suffix.length)}–${b}` : `${a}–${b}`;
  }
  if (lo !== null) return `≥ ${formatValue(lo, metric.unit)}`;
  if (hi !== null) return `≤ ${formatValue(hi, metric.unit)}`;
  return '';
}

function unitSuffix(unit: string): string {
  return unit === 'deg' ? '°' : unit === 'T' ? ' T' : unit === 'T/s' ? ' T/s' : '';
}

/** Rubric joints are written for right-handers; mirror l/r for left-handed players. */
export function mirrorJoints(joints: readonly Joint[], left: boolean): Joint[] {
  if (!left) return [...joints];
  return joints.map((j) => (/^[lr][A-Z]/.test(j) ? `${j[0] === 'l' ? 'r' : 'l'}${j.slice(1)}` : j) as Joint);
}
