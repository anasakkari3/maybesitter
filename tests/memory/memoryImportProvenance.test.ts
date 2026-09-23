/**
 * How a record brought from another assistant explains itself.
 *
 * ── The one thing this row can say that no other row can ─────────
 *
 * "You brought this from ChatGPT, and you confirmed it." Every other label
 * answers "did I say this, or did you decide it?"; this one has a third
 * answer, and it needs the assistant's name to give it. So `assistant` is a
 * field on the provenance rather than a prefix smuggled into `originRef`:
 * `originRef` is the proposal id for every other origin, and a second
 * colon-delimited grammar the phone has to split is a mistake this repo has
 * already declined once (see `MemoryPatternDto`).
 *
 * Both an edited and an unedited import row get the same label. Every import
 * row is confirmed by construction — nothing reaches the store without the
 * user keeping it — so the confirmed/unconfirmed split that `model_inferred`
 * needs has nothing to carry here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MEMORY_ORIGINS } from '../../src/contracts/v1/memoryContracts.ts';
import type { MemoryProvenance, RuntimeMemoryRecord } from '../../src/contracts/v1/memoryContracts.ts';
import { memoryToDto, sourceLabelOf } from '../../lib/services/mobile/memoryService.ts';

const CONFIRMED_AT = '2026-09-23T09:00:00.000Z';

function provenance(overrides: Partial<MemoryProvenance> = {}): MemoryProvenance {
  return {
    origin: 'ai_context_import',
    originRef: 'imp_1',
    assistant: 'chatgpt',
    confirmedByUserAt: CONFIRMED_AT,
    ...overrides,
  };
}

function record(overrides: Partial<RuntimeMemoryRecord> = {}): RuntimeMemoryRecord {
  return {
    version: 'runtime-memory-v1',
    id: 'mem_1',
    scopeId: 'uid_1',
    kind: 'fact',
    content: 'Is a nursing student',
    language: 'en',
    source: 'model_inferred',
    confidence: 0.9,
    exportPolicy: 'personal_never_export',
    status: 'active',
    createdAt: CONFIRMED_AT,
    updatedAt: CONFIRMED_AT,
    observedAt: CONFIRMED_AT,
    staleAfter: '2026-12-22T09:00:00.000Z',
    evidenceIds: [],
    provenance: provenance(),
    ...overrides,
  } as RuntimeMemoryRecord;
}

test('the new origin is in the array as well as the union', () => {
  // Two independent lists, and a drift between them is a record the client
  // parses and the server cannot name.
  assert.ok(MEMORY_ORIGINS.includes('ai_context_import'));
});

test('an unedited import row says it was brought from an assistant', () => {
  assert.equal(sourceLabelOf(record()), 'you_brought_from_ai');
});

test('an edited import row says the same thing', () => {
  const edited = record({
    source: 'user_stated',
    confidence: 1,
    provenance: provenance({ model: undefined, promptVersion: undefined }),
  });
  assert.equal(sourceLabelOf(edited), 'you_brought_from_ai');
});

test('a self description is still labelled as one', () => {
  const described = record({ provenance: provenance({ origin: 'self_description', assistant: undefined }) });
  assert.equal(sourceLabelOf(described), 'model_suggested_you_confirmed');
});

test('the assistant name reaches the client', () => {
  const dto = memoryToDto(record({ provenance: provenance({ model: 'gemini-2.5-flash', promptVersion: 'ai-context-import-v1' }) }));
  assert.equal(dto.provenance?.assistant, 'chatgpt');
});

test('the model and prompt version are still stripped', () => {
  const dto = memoryToDto(record({ provenance: provenance({ model: 'gemini-2.5-flash', promptVersion: 'ai-context-import-v1' }) }));
  assert.equal(dto.provenance?.model, undefined);
  assert.equal(dto.provenance?.promptVersion, undefined);
  assert.equal(dto.provenance?.origin, 'ai_context_import');
});
