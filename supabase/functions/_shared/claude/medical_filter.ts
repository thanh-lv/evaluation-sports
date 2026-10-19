/**
 * Medical-term filter (DESIGN.md §8.4 step 8). Model text must not diagnose or name injuries, conditions, tissues
 * or treatments; a hit replaces the text and adds one generic `see_professional` note (postprocess does that).
 *
 * Matching: text is NFC-normalised and lower-cased; each term is wrapped in Unicode-aware boundaries
 * `(?<![\p{L}\p{N}])term(?![\p{L}\p{N}])` with the `u` flag, so "tear" does not match "teardrop" and Vietnamese
 * syllables with diacritics count as letters. Terms are regex sources (already lower-case, NFC); a trailing
 * `\p{L}*` marks a stem. The lists await the coach review (M17).
 */

export const MEDICAL_TERMS_EN: readonly string[] = [
  'diagnos\\p{L}*',
  'tendinitis',
  'tendonitis',
  'tendinopathy',
  'tendon\\p{L}*',
  'ligament\\p{L}*',
  'tears?',
  'torn',
  'ruptur\\p{L}*',
  'sprain\\p{L}*',
  'fractur\\p{L}*',
  'dislocat\\p{L}*',
  'inflamm\\p{L}*',
  'arthritis',
  'bursitis',
  'impingement',
  'rotator cuff',
  'tennis elbow',
  "golfer'?s elbow",
  'epicondyl\\p{L}*',
  'plantar fasci\\p{L}*',
  'meniscus',
  'cartilage',
  'herniat\\p{L}*',
  'hernia',
  'sciatica',
  'syndrome',
  'concussion',
  'surgery',
  'surgical',
  'mri',
  'x-rays?',
  'painkillers?',
  'ibuprofen',
  'paracetamol',
  'anti-inflammator\\p{L}*',
  'medication',
  'prescri\\p{L}*',
];

export const MEDICAL_TERMS_VI: readonly string[] = [
  'chẩn đoán',
  'viêm',
  'gân',
  'dây chằng',
  'rách cơ',
  'gãy xương',
  'nứt xương',
  'trật khớp',
  'bong gân',
  'thoát vị',
  'thoái hóa',
  'thoái hoá',
  'sụn',
  'chấn động não',
  'phẫu thuật',
  'mổ',
  'chụp x-quang',
  'chụp mri',
  'thuốc giảm đau',
  'thuốc kháng viêm',
  'kê đơn',
  'hội chứng',
];

function compile(terms: readonly string[]): RegExp {
  const alt = terms.map((t) => t.normalize('NFC')).join('|');
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt})(?![\\p{L}\\p{N}])`, 'u');
}

const PATTERN = compile([...MEDICAL_TERMS_EN, ...MEDICAL_TERMS_VI]);

export function normalizeForMatch(text: string): string {
  return text.normalize('NFC').toLowerCase();
}

/** The first medical term found (as it appears in the normalised text), or null. */
export function findMedicalTerm(text: string): string | null {
  const m = PATTERN.exec(normalizeForMatch(text));
  return m ? m[0] : null;
}

export function hasMedicalTerm(text: string): boolean {
  return findMedicalTerm(text) !== null;
}
