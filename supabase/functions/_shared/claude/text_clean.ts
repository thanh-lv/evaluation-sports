/**
 * Text hygiene for model prose (DESIGN.md §7.4, §8.4 step 4): `observation` must hold no digits or units, because
 * the measured value is shown next to it by the app. Numbers with their unit are removed, then any stray digit.
 */

/** A number (optionally signed, with decimals or a range) followed by an optional unit. */
const NUMBER_WITH_UNIT = new RegExp(
  String.raw`[+\-−±~≈]?\s*\d+(?:[.,]\d+)*(?:\s*(?:[-–—]|to|đến|tới)\s*\d+(?:[.,]\d+)*)?` +
    String.raw`\s*(?:%|°|º|độ|degrees?|deg|cm|mm|km\/h|m\/s|t\/s|ms|giây|seconds?|secs?|s|m|t|x|×|lần|times|phần trăm|percent)?` +
    String.raw`(?![\p{L}\p{N}])`,
  'giu',
);
const STRAY = /[\d%°º]/gu;

export function hasDigits(text: string): boolean {
  return /\p{Nd}/u.test(text);
}

/** Removes numbers with their units and tidies the spacing and punctuation left behind. */
export function stripNumbers(text: string): string {
  return text
    .replace(NUMBER_WITH_UNIT, ' ')
    .replace(STRAY, ' ')
    .replace(/\(\s*\)/g, ' ')
    .replace(/\s+([,.;:!?)])/g, '$1')
    .replace(/([,;:])(?:\s*[,;:])+/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,.;:–—-]+/, '')
    .trim();
}

/** Words that contain at least one letter. */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;
}

export function capitalize(text: string): string {
  const t = text.trim();
  return t ? t[0].toLocaleUpperCase('vi') + t.slice(1) : t;
}

/** Plain-template sentence: capitalised, ending with a full stop. */
export function sentence(text: string): string {
  const t = capitalize(text);
  return t && !/[.!?…]$/.test(t) ? `${t}.` : t;
}
