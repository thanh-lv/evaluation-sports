/**
 * GET /analyze/catalog (DESIGN.md §6.1): enabled skills (rubric ∩ `enabled_skills`) with VI/EN names, allowed and
 * recommended views with their coverage, the solo flag, and the paywall numbers from `plan_limits`. Cached 1 h.
 */
import {
  type CatalogPlan,
  type CatalogResponseV1,
  type CatalogSkill,
  type Sport,
  type Tier,
  viewFactorColumn,
} from '@shared/contracts/index.ts';
import type { Db } from '@shared/db.ts';
import { loadRubric } from '@shared/rubric/load.ts';
import type { CheckpointDef, SkillDef, ViewCode } from '@shared/rubric/types.ts';

const TIER_ORDER: readonly Tier[] = ['free', 'trial', 'premium'];

/** Share of the skill's checkpoint weight that is assessable from `view` (factor > 0, not an N item). */
export function viewCoverage(skill: SkillDef, checkpoints: readonly CheckpointDef[], view: ViewCode): number {
  const defs = checkpoints.filter((c) => skill.checkpoints.includes(c.id));
  const total = defs.reduce((s, c) => s + c.weight, 0);
  if (total === 0) return 0;
  const { column } = viewFactorColumn(view);
  const ok = defs.filter((c) => c.assess !== 'N' && c.views[column] > 0).reduce((s, c) => s + c.weight, 0);
  return Math.round((ok / total) * 100) / 100;
}

export function catalogSkill(skill: SkillDef, checkpoints: readonly CheckpointDef[]): CatalogSkill {
  const viewCoverageMap: CatalogSkill['viewCoverage'] = {};
  for (const v of skill.views.allowed) viewCoverageMap[v] = viewCoverage(skill, checkpoints, v);
  return {
    id: skill.id as CatalogSkill['id'],
    sport: skill.sport,
    name: { vi: skill.name.vi, en: skill.name.en },
    views: { recommended: [...skill.views.recommended], allowed: [...skill.views.allowed] },
    viewCoverage: viewCoverageMap,
    solo: skill.solo,
  };
}

interface PlanRow {
  tier: Tier;
  period_type: CatalogPlan['periodType'];
  total_limit: number;
  standard_limit: number;
}

export async function buildCatalog(db: Db): Promise<CatalogResponseV1> {
  const enabled = await db.selectMany<{ skill: string; sport: Sport }>(
    'public',
    'enabled_skills',
    'skill, sport',
    { enabled: true },
    { order: { column: 'skill' } },
  );
  const skills: CatalogSkill[] = [];
  for (const sport of ['badminton', 'pickleball'] as const) {
    const rubric = loadRubric(sport);
    const on = new Set(enabled.filter((e) => e.sport === sport).map((e) => e.skill));
    // rubric order (launch order), enabled ones only
    for (const s of rubric.skills) if (on.has(s.id)) skills.push(catalogSkill(s, rubric.checkpoints));
  }
  const plans = (await db.selectMany<PlanRow>(
    'public',
    'plan_limits',
    'tier, period_type, total_limit, standard_limit',
    {},
  ))
    .sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier))
    .map((p): CatalogPlan => ({
      tier: p.tier,
      periodType: p.period_type,
      totalLimit: p.total_limit,
      standardLimit: p.standard_limit,
    }));
  return { schema: 'catalog.v1', skills, plans };
}

/** Per-worker cache of the catalog (it changes only when an operator edits enabled_skills / plan_limits). */
export class CatalogCache {
  private value: { at: number; body: CatalogResponseV1 } | null = null;
  constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {}

  async get(load: () => Promise<CatalogResponseV1>): Promise<CatalogResponseV1> {
    const t = this.now();
    if (this.value && t - this.value.at < this.ttlMs) return this.value.body;
    const body = await load();
    this.value = { at: t, body };
    return body;
  }
}

/** Sport-filtered enabled skills, for pose validation (`validatePoseAgainstCatalog`). */
export function enabledSkillMap(catalog: CatalogResponseV1): Map<CatalogSkill['id'], Sport> {
  return new Map(catalog.skills.map((s) => [s.id, s.sport]));
}
