/**
 * Rubric loader. The JSON is imported statically (bundled with the function, no I/O) and validated once.
 * `rubricVersion` (sha256 of the canonical JSON, DESIGN.md §6.3) uses WebCrypto, available in Deno and browsers.
 */
import badmintonJson from './badminton.json' with { type: 'json' };
import pickleballJson from './pickleball.json' with { type: 'json' };
import drillsJson from './drills.json' with { type: 'json' };
import type { Sport } from '../contracts/common.ts';
import { DrillsFileSchema, SportRubricFileSchema } from './schema.ts';
import type { DrillsFile, RubricBundle, SportRubricFile } from './types.ts';

const RAW: Readonly<Record<Sport, unknown>> = { badminton: badmintonJson, pickleball: pickleballJson };
const cache = new Map<Sport, RubricBundle>();
let drillsCache: DrillsFile | null = null;

function drills(): DrillsFile {
  drillsCache ??= DrillsFileSchema.parse(drillsJson);
  return drillsCache;
}

/** Throws (ZodError) if the bundled JSON is malformed: a deploy-time bug, never a user error. */
export function loadRubric(sport: Sport): RubricBundle {
  const hit = cache.get(sport);
  if (hit) return hit;
  const file: SportRubricFile = SportRubricFileSchema.parse(RAW[sport]);
  if (file.sport !== sport) throw new Error(`rubric file for ${sport} declares sport ${file.sport}`);
  const d = drills();
  const bundle: RubricBundle = {
    version: `${file.version}+drills-${d.version}`,
    sport,
    skills: file.skills,
    checkpoints: file.checkpoints,
    faults: file.faults,
    drills: d.drills.filter((x) => x.sport === sport),
  };
  cache.set(sport, bundle);
  return bundle;
}

/** Canonical JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** `rubric_version` stored on analyses/results: hex sha256 of the bundle's canonical JSON. */
export async function rubricVersion(bundle: RubricBundle): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(bundle));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Map of every rubric skill → sport; intersect with `enabled_skills` before validatePoseAgainstCatalog. */
export function allRubricSkills(): Map<string, Sport> {
  const out = new Map<string, Sport>();
  for (const sport of ['badminton', 'pickleball'] as const) {
    for (const s of loadRubric(sport).skills) out.set(s.id, sport);
  }
  return out;
}
