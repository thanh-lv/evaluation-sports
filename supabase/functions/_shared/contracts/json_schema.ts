/** Minimal JSON Schema typing for hand-built schemas (the Claude output schema) and the audit. */

export type JsonPrimitive = string | number | boolean | null;

export interface JsonSchema {
  $schema?: string;
  $id?: string;
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  title?: string;
  description?: string;
  type?: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | 'null' | string[];
  enum?: JsonPrimitive[];
  const?: JsonPrimitive;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  [keyword: string]: unknown;
}
