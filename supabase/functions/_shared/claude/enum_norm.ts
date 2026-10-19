/**
 * Case-insensitive enum matching (DESIGN.md §8.4 step 2): the lenient parser accepts any string for enum fields, so
 * every value is trimmed and matched against its canonical list ignoring case; values that do not match are dropped
 * by the caller.
 */

export class EnumMatcher<T extends string> {
  private readonly byKey: Map<string, T>;

  constructor(values: Iterable<T>) {
    this.byKey = new Map();
    for (const v of values) this.byKey.set(v.trim().toLowerCase(), v);
  }

  /** Canonical value, or null when unknown. */
  match(value: unknown): T | null {
    if (typeof value !== 'string') return null;
    return this.byKey.get(value.trim().toLowerCase()) ?? null;
  }

  has(value: unknown): boolean {
    return this.match(value) !== null;
  }
}
