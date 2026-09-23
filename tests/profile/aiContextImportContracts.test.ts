/**
 * The caps that keep an imported profile inside the model's input ceiling.
 *
 * ── The arithmetic is a test, not a comment ──────────────────────
 *
 * `MAX_INPUT_CHARACTERS` is 20,000 and is checked against the whole built
 * prompt, so this feature's input cap is not a product choice — it is what is
 * left after the rules, forty numbered memories and the framing. A comment
 * claiming the sum works is a comment that goes stale the first time somebody
 * adds a paragraph of rules. This file fails instead.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CANDIDATE_LENGTH,
  MAX_EXISTING_MEMORY_RECORDS,
  MAX_IMPORT_CANDIDATES,
  MAX_IMPORT_LENGTH,
  MAX_IMPORTS_PER_DAY,
  MIN_CANDIDATE_CONFIDENCE,
  IMPORT_ASSISTANTS,
} from '../../src/profile/aiContextImportContracts.ts';
import { buildAiContextImportPrompt, AI_CONTEXT_IMPORT_SCHEMA } from '../../src/profile/aiContextImportPrompt.ts';
import { MAX_INPUT_CHARACTERS } from '../../lib/llm/usageGuard.ts';
import { MAX_MEMORY_CONTENT_LENGTH } from '../../lib/services/mobile/memoryService.ts';
import { toVertexSchema } from '../../src/extraction/llm/vertexSchema.ts';

/** The worst case the service can actually produce. */
function worstCasePrompt(): string {
  const existing = Array.from({ length: MAX_EXISTING_MEMORY_RECORDS }, (_, i) => ({
    index: i + 1,
    content: 'م'.repeat(MAX_MEMORY_CONTENT_LENGTH),
  }));
  return buildAiContextImportPrompt('x'.repeat(MAX_IMPORT_LENGTH), existing);
}

test('the worst case a user can send fits under the model input ceiling', () => {
  const built = worstCasePrompt();
  assert.ok(
    built.length <= MAX_INPUT_CHARACTERS,
    `worst case is ${built.length}, over the ${MAX_INPUT_CHARACTERS} ceiling`,
  );
});

test('the worst case leaves room for the rules to grow', () => {
  // A prompt that only just fits is one edit away from refusing every import
  // at the usage guard, which surfaces as "nothing to suggest" rather than as
  // an error. 1,000 characters is the margin this feature is allowed to spend
  // before the caps have to move.
  const headroom = MAX_INPUT_CHARACTERS - worstCasePrompt().length;
  assert.ok(headroom >= 1_000, `only ${headroom} characters of headroom left`);
});

test('a memory id never reaches the model', () => {
  const built = buildAiContextImportPrompt('a paste', [
    { index: 1, content: 'sleeps from 22:30 to 06:30' },
  ]);
  assert.ok(!built.includes('mem_'), 'a record id appeared in the prompt');
});

test('the response schema converts to the Vertex subset', () => {
  assert.doesNotThrow(() => toVertexSchema(AI_CONTEXT_IMPORT_SCHEMA));
});

test('a candidate can never be too long for the memory store', () => {
  assert.ok(MAX_CANDIDATE_LENGTH <= MAX_MEMORY_CONTENT_LENGTH);
});

test('the caps are the ones the plan derived', () => {
  assert.equal(MAX_IMPORT_LENGTH, 4_000);
  assert.equal(MAX_EXISTING_MEMORY_RECORDS, 40);
  assert.equal(MAX_IMPORT_CANDIDATES, 18);
  assert.equal(MAX_CANDIDATE_LENGTH, 120);
  assert.equal(MIN_CANDIDATE_CONFIDENCE, 0.6);
  assert.equal(MAX_IMPORTS_PER_DAY, 3);
  assert.deepEqual([...IMPORT_ASSISTANTS], ['chatgpt', 'gemini', 'claude', 'other']);
});
