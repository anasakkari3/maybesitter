/**
 * The extraction schema, translated for Vertex (UC-2.0, #160).
 *
 * The risk here is not a wrong translation — a wrong one fails loudly, with a
 * 400 on every call. It is a translation that drifts from the schema the
 * validator enforces. Then the model is asked for one shape, judged against
 * another, and every capture quietly falls back to rules while the system
 * looks configured.
 *
 * So the Vertex dialect is derived from the JSON Schema, and these assert the
 * derivation is faithful and that the conversion refuses what it cannot
 * translate rather than dropping it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { toVertexSchema } from '../../src/extraction/llm/vertexSchema.ts';
import { GEMINI_EXTRACTION_SCHEMA, OLLAMA_EXTRACTION_SCHEMA } from '../../src/extraction/ollamaExtractionSchema.ts';

type Node = Record<string, unknown>;

test('a nullable union becomes a nullable type', () => {
  assert.deepEqual(toVertexSchema({ type: ['string', 'null'] }), { type: 'string', nullable: true });
  assert.deepEqual(toVertexSchema({ type: 'string' }), { type: 'string' });
});

test('a boolean const becomes a boolean, because the validator is what pins it', () => {
  // `pressureAllowed: { const: false }` cannot be expressed to Vertex. It stays
  // enforced where it was always enforced.
  assert.deepEqual(toVertexSchema({ const: false }), { type: 'boolean' });
  assert.throws(() => toVertexSchema({ const: 'no' }), /only a boolean const/);
});

test('additionalProperties is dropped, and anything unrecognised is refused', () => {
  assert.deepEqual(
    toVertexSchema({ type: 'object', additionalProperties: false, properties: { a: { type: 'string' } }, required: ['a'] }),
    { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
  );

  // The important half: a construct that is neither carried nor deliberately
  // dropped is a constraint someone wrote and Vertex will not apply.
  assert.throws(() => toVertexSchema({ type: 'string', pattern: '^a' } as never), /no Vertex translation for pattern/);
  assert.throws(() => toVertexSchema({ type: ['string', 'number'] }), /exactly one concrete type/);
});

test('the error names the path, so a deep mismatch is findable', () => {
  assert.throws(
    () => toVertexSchema({ type: 'object', properties: { outer: { type: 'object', properties: { inner: { minLength: 2 } as never } } } }),
    /\$\.outer\.inner: no Vertex translation for minLength/,
  );
});

test('the derived schema describes exactly the fields the validator expects', () => {
  // Field-for-field, at every depth. This is the drift the whole derivation
  // exists to prevent.
  const walk = (json: Node, vertex: Node, path: string): void => {
    const jsonProps = json.properties as Record<string, Node> | undefined;
    const vertexProps = vertex.properties as Record<string, Node> | undefined;
    if (!jsonProps) {
      assert.equal(vertexProps, undefined, `${path}: Vertex has properties the source does not`);
      return;
    }
    assert.ok(vertexProps, `${path}: the derived schema lost its properties`);
    assert.deepEqual(
      Object.keys(vertexProps).sort(),
      Object.keys(jsonProps).sort(),
      `${path}: the two schemas describe different fields`,
    );
    assert.deepEqual(
      [...((json.required as string[] | undefined) ?? [])].sort(),
      [...((vertex.required as string[] | undefined) ?? [])].sort(),
      `${path}: the two schemas require different fields`,
    );
    for (const key of Object.keys(jsonProps)) walk(jsonProps[key]!, vertexProps[key]!, `${path}.${key}`);
  };

  walk(OLLAMA_EXTRACTION_SCHEMA as unknown as Node, GEMINI_EXTRACTION_SCHEMA as Node, '$');
});

test('the derived schema carries no construct Vertex rejects', () => {
  const serialised = JSON.stringify(GEMINI_EXTRACTION_SCHEMA);
  assert.equal(serialised.includes('additionalProperties'), false);
  assert.equal(serialised.includes('"const"'), false);
  // A `type` array is the JSON Schema spelling of nullable; Vertex wants the
  // flag instead, and it must be present where the source had null.
  assert.equal(/"type":\s*\[/.test(serialised), false);
  assert.equal(serialised.includes('"nullable":true'), true, 'nothing became nullable, so the conversion did nothing');
});

test('enums and numeric bounds survive the translation', () => {
  const properties = (GEMINI_EXTRACTION_SCHEMA as Node).properties as Record<string, Node>;
  assert.deepEqual((properties.type as Node).enum, ['task', 'follow_up', 'informational_context', 'unknown']);
  const confidence = (properties.confidence as Node).properties as Record<string, Node>;
  assert.equal((confidence.overall as Node).minimum, 0);
  assert.equal((confidence.overall as Node).maximum, 1);
});
