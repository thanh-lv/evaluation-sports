/**
 * Deterministic pretty JSON for generated files: 2-space indent, but arrays whose items are all primitives stay on
 * one line (pose frames would otherwise produce one line per number). Always ends with a newline.
 */
export function prettyJson(value: unknown): string {
  return `${render(value, '')}\n`;
}

function isPrimitive(v: unknown): boolean {
  return v === null || typeof v !== 'object';
}

function render(value: unknown, indent: string): string {
  if (isPrimitive(value)) return JSON.stringify(value);
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every(isPrimitive)) return `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
    return `[\n${value.map((v) => inner + render(v, inner)).join(',\n')}\n${indent}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return '{}';
  return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${render(v, inner)}`).join(',\n')}\n${indent}}`;
}

/** Repo root, resolved from this file (scripts/_lib/json.ts). */
export const REPO_ROOT = new URL('../../', import.meta.url);

export function repoPath(relative: string): string {
  return new URL(relative, REPO_ROOT).pathname;
}
