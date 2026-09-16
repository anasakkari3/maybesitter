/**
 * Reading a category out of a model's answer (#415).
 *
 * The division of labour matters here and the tests are written to hold it:
 * this layer decides only what *shape* arrived, and `resolveCategory` in
 * `categoryContracts.ts` decides whether that shape is good enough to keep.
 * So the validator passes a confidence through untouched rather than applying
 * the floor itself — two places applying the same floor is two places to get
 * it wrong, and the one that runs second wins silently.
 *
 * The rule-based path is tested for what it must *not* do. When the model is
 * unavailable every capture still has to produce a result, and the tempting
 * fix is a keyword table: "meeting" is work, "doctor" is health. That table is
 * wrong in Arabic, wrong in Hebrew, wrong for "meeting the school", and worst
 * of all it is confidently wrong — it produces a category indistinguishable
 * from one the model reasoned about. Silence is the honest fallback.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { validateExtractionResult } from '../../src/extraction/schemaValidator.ts';
import { extract as ruleBasedExtract } from '../../src/extraction/ruleBasedExtractor.ts';
import { OLLAMA_EXTRACTION_SCHEMA } from '../../src/extraction/ollamaExtractionSchema.ts';
import { COMMITMENT_CATEGORIES } from '../../src/contracts/v1/categoryContracts.ts';

const context = { now: new Date('2026-04-08T09:00:00.000Z'), timezone: 'UTC' };

function modelSaid(extra: Record<string, unknown>) {
  return validateExtractionResult(
    {
      type: 'task',
      action: 'send',
      title: 'Send the invoice',
      person: null,
      dueAt: null,
      remindAt: null,
      localTimeSpec: null,
      priority: { level: 'normal', source: 'inferred', pressureAllowed: false, pressureImplied: false },
      flexibility: 'movable',
      confidence: { overall: 0.9, type: 0.9, action: 0.9, time: 0.5, priority: 0.8 },
      missingFields: [],
      ambiguityFlags: [],
      explicitReminderRequest: false,
      explicitPressureRequest: false,
      ...extra,
    },
    'Send the invoice',
    context,
  );
}

test('the schema asks the model for a category from the catalog and nothing else', () => {
  const property = OLLAMA_EXTRACTION_SCHEMA.properties.category;
  assert.deepEqual([...property.enum], [...COMMITMENT_CATEGORIES]);
  assert.deepEqual([...property.type], ['string', 'null']);
});

test('the schema asks the model how sure it is about the category', () => {
  assert.equal(OLLAMA_EXTRACTION_SCHEMA.properties.categoryConfidence.type, 'number');
});

test('a category from the catalog is read off the model answer', () => {
  const result = modelSaid({ category: 'work', categoryConfidence: 0.9 });
  assert.equal(result.category, 'work');
  assert.equal(result.categoryConfidence, 0.9);
});

test('a category the model invented is not read as a category', () => {
  const result = modelSaid({ category: 'hobbies', categoryConfidence: 0.95 });
  assert.equal(result.category, null);
});

test('a model answer with no category at all reads as uncategorised', () => {
  const result = modelSaid({});
  assert.equal(result.category, null);
  assert.equal(result.categoryConfidence, 0);
});

test('a low confidence is passed through rather than applied here', () => {
  const result = modelSaid({ category: 'work', categoryConfidence: 0.2 });
  assert.equal(result.category, 'work');
  assert.equal(result.categoryConfidence, 0.2);
});

test('a confidence outside the unit range is clamped, not trusted', () => {
  assert.equal(modelSaid({ category: 'work', categoryConfidence: 7 }).categoryConfidence, 1);
  assert.equal(modelSaid({ category: 'work', categoryConfidence: -3 }).categoryConfidence, 0);
  assert.equal(modelSaid({ category: 'work', categoryConfidence: 'high' }).categoryConfidence, 0);
});

test('an invented category cannot arrive with a confidence that would let it through', () => {
  const result = modelSaid({ category: 'hobbies', categoryConfidence: 1 });
  assert.equal(result.category, null);
  assert.equal(result.categoryConfidence, 0);
});

test('the rule-based fallback never guesses a category, whatever the words are', () => {
  for (const text of [
    'Send the quarterly report to the team meeting tomorrow',
    'خذ الولد على الدكتور بكرا',
    'לשלם את החשבון ביום ראשון',
  ]) {
    const result = ruleBasedExtract(text, context);
    assert.equal(result.category, null, text);
    assert.equal(result.categoryConfidence, 0, text);
  }
});
