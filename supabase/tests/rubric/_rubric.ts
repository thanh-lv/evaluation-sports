/** Shared helpers for the rubric integrity tests (not a test file: no `.test.ts` suffix). */
import type { LocalizedText } from '@shared/contracts/common.ts';
import { loadRubric } from '@shared/rubric/load.ts';
import type { RubricBundle } from '@shared/rubric/types.ts';

export const SPORTS_UNDER_TEST = ['badminton', 'pickleball'] as const;

export const bundles = (): RubricBundle[] => SPORTS_UNDER_TEST.map((s) => loadRubric(s));

/**
 * Skills enabled at launch (DESIGN.md §2.1). The live switch is the `enabled_skills` table; this list only drives
 * the stricter launch checks below.
 */
export const LAUNCH_SKILLS = ['bd.clear_fh', 'bd.smash', 'bd.serve_low', 'pb.serve', 'pb.dink', 'pb.drop3'] as const;
export const DEFERRED_SKILLS = [
  'bd.net_shot',
  'bd.lift',
  'bd.serve_high',
  'pb.return',
  'pb.drive',
  'pb.volley',
] as const;

/** Every `{vi, en}` pair in a value, with a JSON-path-ish label for error messages. */
export function localizedTexts(value: unknown, path = '$'): Array<[string, LocalizedText]> {
  const out: Array<[string, LocalizedText]> = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => out.push(...localizedTexts(v, `${path}[${i}]`)));
  } else if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.vi === 'string' && typeof obj.en === 'string') out.push([path, obj as LocalizedText]);
    for (const [k, v] of Object.entries(obj)) out.push(...localizedTexts(v, `${path}.${k}`));
  }
  return out;
}

/** Every string in a value with its path. */
export function allStrings(value: unknown, path = '$'): Array<[string, string]> {
  if (typeof value === 'string') return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => allStrings(v, `${path}[${i}]`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => allStrings(v, `${path}.${k}`));
  }
  return [];
}

export const wordCount = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;
