/**
 * The extraction schema, in the dialect Vertex accepts (UC-2.0, #160).
 *
 * Vertex's structured output takes an OpenAPI subset, and the schema this
 * repository already has is JSON Schema. Three things differ:
 *
 *   - `type: ['string', 'null']`  →  `{ type: 'string', nullable: true }`
 *   - `const: false`              →  `{ type: 'boolean' }` (the validator is
 *                                     what actually holds it to `false`)
 *   - `additionalProperties`      →  not accepted, dropped
 *
 * ── Why this is derived and not written out again ────────────────
 *
 * The obvious alternative is a second constant next to the first. Two hand-kept
 * copies of one schema drift the first time a field is added, and the drift is
 * silent: the model would be asked for a shape the validator does not expect,
 * and every capture would fall back to rules while looking configured. So the
 * Vertex dialect is computed from the JSON Schema, and a test asserts the two
 * describe the same fields.
 *
 * The conversion refuses anything it does not recognise rather than passing it
 * through. A construct Vertex rejects is a 400 on every call, and a construct
 * it silently ignores is a constraint that is not really there.
 */

/**
 * Readonly throughout: the source schema is declared `as const`, so every
 * array on it is a readonly tuple. Accepting mutable ones would mean casting
 * the very thing being converted.
 */
export interface JsonSchemaNode {
  readonly type?: string | readonly string[];
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly description?: string;
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly required?: readonly string[];
  readonly items?: JsonSchemaNode;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly additionalProperties?: boolean;
}

/** Keys that carry meaning for Vertex. Anything else has to be handled above. */
const CARRIED = new Set(['type', 'enum', 'description', 'properties', 'required', 'items', 'minimum', 'maximum']);
/** Dropped deliberately: Vertex rejects it, and the validator enforces it. */
const DROPPED = new Set(['additionalProperties']);

export function toVertexSchema(node: JsonSchemaNode, path = '$'): Record<string, unknown> {
  const unknownKeys = Object.keys(node).filter((key) => !CARRIED.has(key) && !DROPPED.has(key) && key !== 'const');
  if (unknownKeys.length > 0) {
    throw new Error(`${path}: no Vertex translation for ${unknownKeys.join(', ')}`);
  }

  // `const: false` is how the JSON Schema pins `pressureAllowed`. Vertex has no
  // `const`, so it becomes a boolean here and stays pinned by the validator.
  if (node.const !== undefined) {
    if (typeof node.const !== 'boolean') throw new Error(`${path}: only a boolean const can be translated`);
    return { type: 'boolean' };
  }

  const types = Array.isArray(node.type) ? node.type : node.type === undefined ? [] : [node.type];
  const nullable = types.includes('null');
  const concrete = types.filter((type) => type !== 'null');
  if (concrete.length !== 1) {
    throw new Error(`${path}: expected exactly one concrete type, got ${JSON.stringify(node.type)}`);
  }

  const converted: Record<string, unknown> = { type: concrete[0]! };
  if (nullable) converted.nullable = true;
  if (node.description) converted.description = node.description;
  if (node.enum) converted.enum = [...node.enum];
  if (node.minimum !== undefined) converted.minimum = node.minimum;
  if (node.maximum !== undefined) converted.maximum = node.maximum;
  if (node.items) converted.items = toVertexSchema(node.items, `${path}.items`);
  if (node.properties) {
    converted.properties = Object.fromEntries(
      Object.entries(node.properties).map(([key, child]) => [key, toVertexSchema(child, `${path}.${key}`)]),
    );
  }
  if (node.required) converted.required = [...node.required];
  return converted;
}
