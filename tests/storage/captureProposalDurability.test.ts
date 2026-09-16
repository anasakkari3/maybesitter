/**
 * A capture proposed on one instance can be confirmed on another (#252).
 *
 * The first #153 durability run against staging made six captures and got two
 * commitments: the proposal store was a `Map` per process, so a confirm routed
 * to the other instance found nothing, answered `proposal_not_found` — and the
 * route returned HTTP 200. These tests are that failure, made reproducible
 * without a cloud project: a second store instance over the same adapter is
 * what a second instance (or the process after a redeploy) sees.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyDomainState, type Command } from '../../src/domain/stateMachine.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { CAPTURE_PROPOSALS, userDoc } from '../../lib/storage/paths.ts';
import { proposeMobileCapture } from '../../lib/services/mobile/mobileCaptureService.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import {
  confirmCapture,
  proposeCapture,
  MemoryCaptureProposalStore,
  StorageCaptureProposalStore,
  type CapturePersistenceAdapter,
} from '../../lib/services/captureBoundary/index.ts';
import type { ExtractionResult } from '../../src/extraction/extractionTypes.ts';

const NOW = new Date('2026-08-17T08:00:00.000Z');
const SCOPE = 'user_capture_1';

function extracted(): ExtractionResult {
  return {
    type: 'task',
    action: 'Call the doctor',
    title: 'Call the doctor',
    person: null,
    dueAt: '2026-08-17T12:00:00.000Z',
    remindAt: '2026-08-17T12:00:00.000Z',
    localTimeSpec: { date: '2026-08-17', time: '12:00', timezone: 'UTC' },
    timeEvidence: 'hhmm',
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureImplied: false },
    flexibility: 'movable',
    category: null,
    categoryConfidence: 0,
    confidence: { overall: 0.95, type: 0.95, action: 0.95, time: 0.95, priority: 0.8 },
    missingFields: [],
    ambiguityFlags: [],
    explicitReminderRequest: true,
    explicitPressureRequest: false,
    rawText: 'Call the doctor at noon',
    parserVersion: 'test-v1',
  };
}

/** Records what reached the canonical write, so a double persist is visible. */
function recordingPersistence(): CapturePersistenceAdapter & { batches: Command[][] } {
  const batches: Command[][] = [];
  return {
    batches,
    snapshot: async () => createEmptyDomainState(),
    async persistAtomically(commands: readonly Command[]) {
      batches.push([...commands]);
      return { state: createEmptyDomainState() };
    },
  } as CapturePersistenceAdapter & { batches: Command[][] };
}

/** One instance's view of the shared backend. */
function instance(storage: StorageAdapter, persistence: CapturePersistenceAdapter) {
  return { store: new StorageCaptureProposalStore(storage), persistence };
}

async function proposeOn(deps: ReturnType<typeof instance>) {
  return proposeCapture('Call the doctor at noon', { now: NOW, timezone: 'UTC', scopeId: SCOPE }, {
    ...deps,
    extractor: async () => ({ result: extracted(), engine: 'ollama', fallbackReason: null }),
  });
}

test('a proposal made on one instance is confirmed on another', async () => {
  const storage = createMemoryStorage();
  const persistence = recordingPersistence();

  const proposal = await proposeOn(instance(storage, persistence));
  assert.equal(proposal.status, 'proposed');
  const itemId = proposal.items[0]!.itemId;

  // A different instance: same backend, no shared memory.
  const other = instance(storage, persistence);
  const result = await confirmCapture(
    { proposalId: proposal.proposalId, scopeId: SCOPE, selectedItemIds: [itemId], idempotencyKey: 'k1' },
    other,
  );

  assert.equal(result.success, true, `confirm on another instance failed: ${result.failureCode ?? ''}`);
  assert.deepEqual(result.persistedItemIds, [itemId]);
  assert.equal(persistence.batches.length, 1, 'the commitment was not written exactly once');
  assert.ok(persistence.batches[0]!.length > 0, 'the commands did not survive the round trip');
});

test('the commands survive storage, which a Map does not force you to check', async () => {
  // `JSON.stringify` turns a Map into `{}` silently. If that happened, confirm
  // would find the proposal and then refuse it as `invalid_selection` — a
  // different silent failure, so it is asserted directly.
  const storage = createMemoryStorage();
  const proposal = await proposeOn(instance(storage, recordingPersistence()));
  const readBack = await new StorageCaptureProposalStore(storage).get(proposal.proposalId);

  assert.ok(readBack, 'the proposal was not stored');
  assert.equal(readBack.scopeId, SCOPE);
  const commands = readBack.commandsByItemId.get(proposal.items[0]!.itemId);
  assert.ok(commands && commands.length > 0, 'commandsByItemId came back empty');
  assert.equal(typeof commands[0]!.type, 'string');
});

test('a confirm replayed on a third instance does not persist a second time', async () => {
  // The Map-backed store recorded the result by mutating the object it held.
  // A durable store needs the write-back, or a replay re-persists everything.
  const storage = createMemoryStorage();
  const persistence = recordingPersistence();
  const proposal = await proposeOn(instance(storage, persistence));
  const itemId = proposal.items[0]!.itemId;
  const request = { proposalId: proposal.proposalId, scopeId: SCOPE, selectedItemIds: [itemId], idempotencyKey: 'k1' };

  const first = await confirmCapture(request, instance(storage, persistence));
  const replay = await confirmCapture(request, instance(storage, persistence));

  assert.equal(first.success, true);
  assert.equal(replay.success, true);
  assert.equal(replay.replayed, true, 'the second confirm was not recognised as a replay');
  assert.equal(persistence.batches.length, 1, 'the commitment was persisted twice');
});

test('another scope cannot confirm the proposal, even though the lookup is by id', async () => {
  const storage = createMemoryStorage();
  const persistence = recordingPersistence();
  const proposal = await proposeOn(instance(storage, persistence));

  const result = await confirmCapture(
    { proposalId: proposal.proposalId, scopeId: 'user_someone_else', selectedItemIds: [proposal.items[0]!.itemId], idempotencyKey: 'k1' },
    instance(storage, persistence),
  );

  assert.equal(result.success, false);
  assert.equal(result.failureCode, 'proposal_not_found');
  assert.equal(persistence.batches.length, 0);
});

test('the per-process store is why this was broken: it cannot confirm across instances', async () => {
  // Pinned deliberately. If someone puts the Map back on the mobile path, this
  // states what that costs rather than leaving it to be rediscovered in
  // production.
  const persistence = recordingPersistence();
  const proposing = { store: new MemoryCaptureProposalStore(), persistence };
  const proposal = await proposeCapture('Call the doctor at noon', { now: NOW, timezone: 'UTC', scopeId: SCOPE }, {
    ...proposing,
    extractor: async () => ({ result: extracted(), engine: 'ollama', fallbackReason: null }),
  });

  const confirming = { store: new MemoryCaptureProposalStore(), persistence };
  const result = await confirmCapture(
    { proposalId: proposal.proposalId, scopeId: SCOPE, selectedItemIds: [proposal.items[0]!.itemId], idempotencyKey: 'k1' },
    confirming,
  );

  assert.equal(result.success, false);
  assert.equal(result.failureCode, 'proposal_not_found');
});

test('the mobile capture path itself stores proposals durably, not in process memory', async () => {
  // The tests above construct StorageCaptureProposalStore directly, so they
  // prove the store works — not that the mobile path uses it. This drives the
  // real route-level service and then looks for the document, which is what
  // goes red if someone puts the per-process Map back (#252).
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  try {
    const uid = 'user_wiring_1';
    const proposal = await proposeMobileCapture(
      { text: 'Remind me to call the dentist tomorrow at 3pm', timezone: 'UTC' },
      { participantId: uid },
    );
    assert.equal(proposal.status, 'proposed', 'the capture did not produce a proposal to store');

    const stored = await storage.listGroup(CAPTURE_PROPOSALS);
    const mine = stored.filter((row) => row.path.startsWith(`${userDoc(uid)}/`));
    assert.equal(mine.length, 1, 'the mobile capture path wrote no proposal to storage');
    assert.equal((mine[0]!.data as { proposalId: string }).proposalId, proposal.proposalId);
  } finally {
    resetStorageForTests();
  }
});
