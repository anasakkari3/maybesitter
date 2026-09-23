/**
 * The order a batch of imported facts comes back in.
 *
 * ── Why this file exists ─────────────────────────────────────────
 *
 * `retrieve`'s last tiebreak is `compareStrings(a.id, b.id)`, and an id is
 * `mem_${randomUUID()}`. Records that share an `observedAt` *and* a `createdAt`
 * therefore come back in a different order on every read — and a bulk import is
 * exactly that shape: eighteen records written in one call. The same defect
 * already shipped once for routine-survey facts, which reshuffled on every
 * pull-to-refresh.
 *
 * `listMemory` re-sorts, which is the load-bearing fix. The stagger on
 * `observedAt` is the second half: without it the list is stable but
 * alphabetical by content, which is not the order the user just read.
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage, resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { createInMemoryRuntimeMemoryStore } from '../../lib/runtimeMemory/runtimeMemoryStore.ts';
import type { RuntimeMemoryStore } from '../../src/contracts/v1/memoryContracts.ts';
import { confirmAiContextImport, importAiContext } from '../../lib/services/mobile/aiContextImportService.ts';
import { listMemory } from '../../lib/services/mobile/memoryService.ts';
import { MAX_IMPORT_CANDIDATES } from '../../src/profile/aiContextImportContracts.ts';

const UID = 'uid_order_1';
const AT = new Date('2026-09-23T09:00:00.000Z');

let memory: RuntimeMemoryStore;

beforeEach(() => {
  resetStorageForTests();
  setStorageForTests(createMemoryStorage());
  memory = createInMemoryRuntimeMemoryStore();
});

/** Content chosen so alphabetical order is the reverse of review order. */
function batch(): Record<string, unknown>[] {
  return Array.from({ length: MAX_IMPORT_CANDIDATES }, (_, i) => ({
    kind: 'fact',
    category: 'work_study',
    content: `${String.fromCharCode(122 - i)} fact number ${i}`,
    targetDate: null,
    confidence: 0.9,
    relation: 'new',
    relatesTo: null,
  }));
}

async function importAll() {
  const candidates = batch();
  const generate = (async () => ({
    text: JSON.stringify({ candidates }), model: 'gemini-2.5-flash', latencyMs: 1, promptTokens: 1, outputTokens: 1,
  })) as never;
  const proposal = await importAiContext(UID, 'a long profile', 'chatgpt', AT, { memory, generate });
  await confirmAiContextImport(
    UID,
    proposal.proposalId,
    proposal.candidates.map((_, index) => ({ index })),
    AT,
    { memory },
  );
  return proposal;
}

test('two reads of a freshly imported batch agree', async () => {
  await importAll();
  const first = (await listMemory(UID, AT.toISOString(), { memory })).map((row) => row.content);
  const second = (await listMemory(UID, AT.toISOString(), { memory })).map((row) => row.content);
  assert.equal(first.length, MAX_IMPORT_CANDIDATES);
  assert.deepEqual(first, second, 'the same batch came back in two different orders');
});

test('the list order is the order the user reviewed', async () => {
  const proposal = await importAll();
  const listed = (await listMemory(UID, AT.toISOString(), { memory })).map((row) => row.content);
  assert.deepEqual(listed, proposal.candidates.map((candidate) => candidate.content));
});

test('no imported record claims to have been observed in the future', async () => {
  await importAll();
  for (const row of await listMemory(UID, AT.toISOString(), { memory })) {
    assert.ok(Date.parse(row.observedAt) <= AT.getTime(), `${row.content} was observed in the future`);
  }
});
