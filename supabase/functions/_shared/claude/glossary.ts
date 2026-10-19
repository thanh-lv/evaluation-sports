/**
 * Typed access to `rubric/glossary.json` (EN ↔ VI app terms, DESIGN.md §10.2). Used for sub-score names in results
 * and the Vietnamese term list in the system prompt.
 */
import glossaryJson from '../rubric/glossary.json' with { type: 'json' };
import type { LocalizedText, Sport, SubScoreKey } from '../contracts/common.ts';

export interface GlossaryTerm {
  id: string;
  en: string;
  vi: string;
}

const TERMS: readonly GlossaryTerm[] = (glossaryJson as { terms: GlossaryTerm[] }).terms.map((t) => ({
  id: t.id,
  en: t.en,
  vi: t.vi,
}));
const BY_ID = new Map(TERMS.map((t) => [t.id, t]));

export function glossaryTerms(): readonly GlossaryTerm[] {
  return TERMS;
}

export function glossaryText(id: string): LocalizedText {
  const t = BY_ID.get(id);
  if (!t) throw new Error(`glossary: missing term ${id}`);
  return { vi: t.vi, en: t.en };
}

/** Display name of a sub-score; `contact` differs per sport (cầu vs bóng). */
export function subScoreName(key: SubScoreKey, sport: Sport): LocalizedText {
  return glossaryText(key === 'contact' ? `contact_${sport}` : key);
}
