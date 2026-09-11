/**
 * User-stated preference corrections (Sprint 10, issue #42).
 *
 * The representation decision under test: a correction is a runtime memory
 * `preference` record with `source: 'user_stated'` and a canonical
 * closed-vocabulary content spelling (`personalization:<dimension>=<level>`).
 * The store is the system of record for statements — the contract's own
 * framing — so a correction rides the statement store's existing revoke,
 * supersede, export, and delete machinery instead of inventing a fifth store.
 *
 * The deriver never reads these records (the contract forbids free-text
 * derivation input); the override happens at the control-center seam, where
 * `effectiveLevelFor` ranks: user correction > operative derivation > product
 * baseline.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createInMemoryRuntimeMemoryStore } from '../../lib/runtimeMemory/runtimeMemoryStore.ts';
import {
  CORRECTION_CONTENT_PREFIX,
  applyCorrection,
  clearCorrection,
  formatCorrectionContent,
  parseCorrectionContent,
  readCorrections,
} from '../../lib/personalizationControls/correction.ts';

const SCOPE = 'scope-corrections';
const NOW = '2026-08-20T10:00:00.000Z';
const LATER = '2026-08-20T11:00:00.000Z';

test('content spelling round-trips through the parser for every dimension and level', () => {
  assert.equal(formatCorrectionContent('pressure_tone', 'firm'), `${CORRECTION_CONTENT_PREFIX}pressure_tone=firm`);
  assert.deepEqual(parseCorrectionContent(`${CORRECTION_CONTENT_PREFIX}pressure_tone=firm`), {
    dimension: 'pressure_tone',
    level: 'firm',
  });
});

test('the parser refuses anything outside the closed vocabulary', () => {
  assert.equal(parseCorrectionContent(`${CORRECTION_CONTENT_PREFIX}pressure_tone=shouty`), null);
  assert.equal(parseCorrectionContent(`${CORRECTION_CONTENT_PREFIX}mood=firm`), null);
  assert.equal(parseCorrectionContent('pressure_tone=firm'), null);
  assert.equal(parseCorrectionContent(`${CORRECTION_CONTENT_PREFIX}pressure_tone=`), null);
  assert.equal(parseCorrectionContent(''), null);
  // A level from another dimension's vocabulary is not valid here.
  assert.equal(parseCorrectionContent(`${CORRECTION_CONTENT_PREFIX}pressure_tone=lean`), null);
});

test('applying a correction writes a user_stated preference record that reads back', async () => {
  const memory = createInMemoryRuntimeMemoryStore();
  const applied = await applyCorrection(memory, SCOPE, 'reminder_density', 'lean', NOW);
  assert.equal(applied.ok, true);
  if (!applied.ok) return;
  assert.equal(applied.record.kind, 'preference');
  assert.equal(applied.record.source, 'user_stated');
  assert.equal(applied.record.exportPolicy, 'personal_never_export');
  assert.equal(applied.record.content, `${CORRECTION_CONTENT_PREFIX}reminder_density=lean`);

  const corrections = await readCorrections(memory, SCOPE, NOW);
  assert.deepEqual(corrections.reminder_density, {
    level: 'lean',
    recordId: applied.record.id,
    statedAt: NOW,
  });
});

test('a second correction on the same dimension supersedes the first, keeping the chain', async () => {
  const memory = createInMemoryRuntimeMemoryStore();
  const first = await applyCorrection(memory, SCOPE, 'pressure_tone', 'firm', NOW);
  const second = await applyCorrection(memory, SCOPE, 'pressure_tone', 'soft', LATER);
  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) return;

  const corrections = await readCorrections(memory, SCOPE, LATER);
  assert.equal(corrections.pressure_tone?.level, 'soft');
  assert.equal(corrections.pressure_tone?.recordId, second.record.id);

  // The prior statement is superseded, not destroyed.
  const prior = await memory.get(first.record.id);
  assert.equal(prior?.status, 'superseded');
  assert.equal(prior?.supersededById, second.record.id);
});

test('corrections on different dimensions do not interfere', async () => {
  const memory = createInMemoryRuntimeMemoryStore();
  await applyCorrection(memory, SCOPE, 'pressure_tone', 'firm', NOW);
  await applyCorrection(memory, SCOPE, 'reminder_density', 'rich', NOW);
  const corrections = await readCorrections(memory, SCOPE, NOW);
  assert.equal(corrections.pressure_tone?.level, 'firm');
  assert.equal(corrections.reminder_density?.level, 'rich');
  assert.equal(corrections.pressure_ceiling, null);
  assert.equal(corrections.suggestion_directness, null);
});

test('clearing a correction revokes the statement, and the dimension reads as uncorrected', async () => {
  const memory = createInMemoryRuntimeMemoryStore();
  const applied = await applyCorrection(memory, SCOPE, 'pressure_tone', 'firm', NOW);
  assert.equal(applied.ok, true);
  assert.equal(await clearCorrection(memory, SCOPE, 'pressure_tone', LATER), true);
  assert.equal((await readCorrections(memory, SCOPE, LATER)).pressure_tone, null);
  // Revoked, not deleted: the record stays inspectable.
  if (applied.ok) assert.equal((await memory.get(applied.record.id))?.status, 'revoked');
});

test('clearing a dimension with no correction reports false rather than inventing one', async () => {
  const memory = createInMemoryRuntimeMemoryStore();
  assert.equal(await clearCorrection(memory, SCOPE, 'pressure_tone', NOW), false);
});

test('an unknown dimension or level is reported, never written', async () => {
  const memory = createInMemoryRuntimeMemoryStore();
  const badDimension = await applyCorrection(memory, SCOPE, 'mood' as never, 'firm', NOW);
  assert.deepEqual(badDimension, { ok: false, reason: 'unknown_dimension' });
  const badLevel = await applyCorrection(memory, SCOPE, 'pressure_tone', 'shouty' as never, NOW);
  assert.deepEqual(badLevel, { ok: false, reason: 'unknown_level' });
  assert.equal((await memory.listAll(SCOPE)).length, 0);
});

test('free-text preference records in the store are not read as corrections', async () => {
  const memory = createInMemoryRuntimeMemoryStore();
  await memory.put({
    scopeId: SCOPE,
    kind: 'preference',
    content: 'I prefer gentle nudges in the morning',
    language: 'en',
    source: 'user_stated',
    confidence: 1,
    observedAt: NOW,
  }, NOW);
  const corrections = await readCorrections(memory, SCOPE, NOW);
  assert.equal(corrections.pressure_tone, null);
  assert.equal(corrections.reminder_density, null);
});

test('a model-inferred record spelling the canonical content is not a user correction', async () => {
  const memory = createInMemoryRuntimeMemoryStore();
  await memory.put({
    scopeId: SCOPE,
    kind: 'preference',
    content: formatCorrectionContent('pressure_tone', 'firm'),
    language: 'en',
    source: 'model_inferred',
    confidence: 0.9,
    observedAt: NOW,
  }, NOW);
  assert.equal((await readCorrections(memory, SCOPE, NOW)).pressure_tone, null);
});

test("a correction never leaves the user's scope", async () => {
  const memory = createInMemoryRuntimeMemoryStore();
  await applyCorrection(memory, 'scope-a', 'pressure_tone', 'firm', NOW);
  assert.equal((await readCorrections(memory, 'scope-b', NOW)).pressure_tone, null);
});
