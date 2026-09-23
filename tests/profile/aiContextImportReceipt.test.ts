/**
 * "Last brought over …", and the promise it has to stop making.
 *
 * ── Why the receipt is not a memory record ───────────────────────
 *
 * It is one small per-account value the Settings row reads on every render. A
 * memory record would put a receipt *about* memory inside memory, and a
 * collection would need its own deletion classification for a single field. It
 * lives on the user document's profile map, beside `profile.routine`, for the
 * reason that one does.
 *
 * ── And why "delete everything" has to reach it ──────────────────
 *
 * `deletePersonalizationScope` purges collections. It does not touch the
 * profile map. So without an explicit clear, a user who deleted everything
 * would come back to a Settings row reporting the date they brought over
 * memories that no longer exist — the delete button's own label being false.
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage, resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { createInMemoryRuntimeMemoryStore } from '../../lib/runtimeMemory/runtimeMemoryStore.ts';
import type { RuntimeMemoryStore } from '../../src/contracts/v1/memoryContracts.ts';
import { confirmAiContextImport, importAiContext, readAiContextImportReceipt } from '../../lib/services/mobile/aiContextImportService.ts';
import { deleteAllMemory } from '../../lib/services/mobile/memoryService.ts';

const UID = 'uid_receipt_1';
const AT = new Date('2026-09-23T09:00:00.000Z');

let memory: RuntimeMemoryStore;

beforeEach(() => {
  resetStorageForTests();
  setStorageForTests(createMemoryStorage());
  memory = createInMemoryRuntimeMemoryStore();
});

async function importAndKeep(): Promise<void> {
  const generate = (async () => ({
    text: JSON.stringify({ candidates: [{
      kind: 'fact', category: 'work_study', content: 'Is a nursing student',
      targetDate: null, confidence: 0.9, relation: 'new', relatesTo: null,
    }] }),
    model: 'gemini-2.5-flash', latencyMs: 1, promptTokens: 1, outputTokens: 1,
  })) as never;
  const proposal = await importAiContext(UID, 'a profile', 'claude', AT, { memory, generate });
  await confirmAiContextImport(UID, proposal.proposalId, [{ index: 0 }], AT, { memory });
}

test('an account that has never imported has no receipt', async () => {
  assert.equal(await readAiContextImportReceipt(UID), null);
});

test('confirming records when, from where, and what happened', async () => {
  await importAndKeep();
  const receipt = await readAiContextImportReceipt(UID);
  assert.equal(receipt?.lastImportedAt, AT.toISOString());
  assert.equal(receipt?.assistant, 'claude');
  assert.equal(receipt?.counts.created, 1);
  assert.equal(receipt?.counts.superseded, 0);
});

test('importing without keeping anything records nothing', async () => {
  // Reading a profile and walking away is not an import. A date here would
  // claim something was brought over when the store is untouched.
  const generate = (async () => ({
    text: JSON.stringify({ candidates: [] }), model: 'm', latencyMs: 1, promptTokens: 1, outputTokens: 1,
  })) as never;
  const proposal = await importAiContext(UID, 'a profile', 'claude', AT, { memory, generate });
  await confirmAiContextImport(UID, proposal.proposalId, [], AT, { memory });
  assert.equal(await readAiContextImportReceipt(UID), null);
});

test('deleting everything takes the date with it', async () => {
  await importAndKeep();
  assert.ok(await readAiContextImportReceipt(UID), 'nothing to delete — the test proved nothing');

  await deleteAllMemory(UID, AT.toISOString(), { memory });

  assert.equal(
    await readAiContextImportReceipt(UID),
    null,
    'the row still claims a date for memories that no longer exist',
  );
});
