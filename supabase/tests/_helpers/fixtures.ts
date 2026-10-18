/** Fixture loading for Deno tests: paths are relative to the repo's shared/fixtures directory. */
const FIXTURES = new URL('../../../shared/fixtures/', import.meta.url);

export async function loadFixture<T = unknown>(relative: string): Promise<T> {
  return JSON.parse(await Deno.readTextFile(new URL(relative, FIXTURES))) as T;
}

/** Deep clone for building negative cases from a valid fixture. */
export function clone<T>(value: T): T {
  return structuredClone(value);
}
