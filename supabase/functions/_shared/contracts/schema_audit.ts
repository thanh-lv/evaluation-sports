/**
 * Audit of a structured-output JSON Schema against the constraints Claude's grammar compiler supports
 * (DESIGN.md §1.1 item 5, §7.4, M1). Returns violations as `<json-pointer>: <problem>`; empty = pass.
 */
import type { JsonSchema } from './json_schema.ts';

const FORBIDDEN_KEYWORDS = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'maxItems',
  'uniqueItems',
  'contains',
  'pattern',
  'patternProperties',
  'format',
  'minProperties',
  'maxProperties',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
  'prefixItems',
  'dependentRequired',
  'dependentSchemas',
] as const;

const REF_PREFIX = '#/$defs/';

type Node = Record<string, unknown>;
const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v);

export function auditCoachOutputSchema(schema: JsonSchema): string[] {
  const problems: string[] = [];
  const defs = isNode(schema.$defs) ? (schema.$defs as Record<string, unknown>) : {};
  const refGraph = new Map<string, Set<string>>(); // def name (or '#') → referenced def names

  const walk = (node: unknown, path: string, owner: string): void => {
    if (Array.isArray(node)) {
      node.forEach((n, i) => walk(n, `${path}/${i}`, owner));
      return;
    }
    if (!isNode(node)) return;

    for (const kw of FORBIDDEN_KEYWORDS) {
      if (kw in node) problems.push(`${path}: forbidden keyword "${kw}"`);
    }
    if ('$schema' in node && path !== '') problems.push(`${path}: nested "$schema"`);
    if (typeof node.minItems === 'number' && node.minItems > 1) problems.push(`${path}: minItems > 1`);

    // `const` is a one-value enum: same rule, so model-facing literals are also defined once in $defs.
    if ('const' in node) problems.push(`${path}: "const" (use a one-value enum in $defs)`);
    if ('enum' in node) {
      // Only allowed as the enum of a top-level $defs entry: /$defs/<Name>
      if (!/^\/\$defs\/[^/]+$/.test(path)) problems.push(`${path}: enum outside $defs`);
      const values = node.enum;
      if (Array.isArray(values) && new Set(values).size !== values.length) {
        problems.push(`${path}: duplicate enum values`);
      }
    }

    if (typeof node.$ref === 'string') {
      const ref = node.$ref;
      if (!ref.startsWith(REF_PREFIX)) problems.push(`${path}: unsupported $ref ${ref}`);
      else {
        const name = ref.slice(REF_PREFIX.length);
        if (!(name in defs)) problems.push(`${path}: dangling $ref ${ref}`);
        if (!refGraph.has(owner)) refGraph.set(owner, new Set());
        refGraph.get(owner)!.add(name);
      }
    }

    const isObject = node.type === 'object' || 'properties' in node;
    if (isObject) {
      if (node.additionalProperties !== false) problems.push(`${path}: additionalProperties must be false`);
      const props = isNode(node.properties) ? Object.keys(node.properties) : [];
      const required = Array.isArray(node.required) ? (node.required as string[]) : [];
      const missing = props.filter((p) => !required.includes(p));
      const extra = required.filter((r) => !props.includes(r));
      if (missing.length) problems.push(`${path}: not required: ${missing.join(', ')}`);
      if (extra.length) problems.push(`${path}: required but undefined: ${extra.join(', ')}`);
    }

    for (const [key, child] of Object.entries(node)) {
      if (key === 'enum' || key === 'required' || key === 'const') continue;
      if (key === '$defs' && path === '') {
        for (const [name, def] of Object.entries(child as Node)) walk(def, `/$defs/${name}`, name);
        continue;
      }
      if (key === '$defs') {
        problems.push(`${path}: nested $defs`);
        continue;
      }
      if (key === 'properties' && isNode(child)) {
        // Property names are data, not keywords: walk each property schema directly.
        for (const [prop, sub] of Object.entries(child)) walk(sub, `${path}/properties/${prop}`, owner);
        continue;
      }
      walk(child, `${path}/${key}`, owner);
    }
  };

  if (schema.type !== 'object') problems.push(': root must be type "object"');
  walk(schema, '', '#');

  // Recursion: any cycle in the $ref graph between $defs.
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (name: string, trail: string[]): void => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'visiting') {
      problems.push(`recursive $ref: ${[...trail, name].join(' → ')}`);
      return;
    }
    state.set(name, 'visiting');
    for (const next of refGraph.get(name) ?? []) visit(next, [...trail, name]);
    state.set(name, 'done');
  };
  for (const name of refGraph.keys()) visit(name, []);

  return problems;
}
