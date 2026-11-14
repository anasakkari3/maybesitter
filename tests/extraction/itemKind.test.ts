/**
 * Event or task, as the model read it at capture (owner decision 2026-11-13,
 * spec lane E1, "Event or task").
 *
 * The model says whether a captured item is an appointment the person attends
 * (a meeting, a lecture, a doctor's visit) or work they do. A confident answer
 * is stored on the commitment's `timeSpec.itemKind`, and the stored kind wins
 * over the title heuristic (`namesEvent`) everywhere that asks "is this an
 * event?". With no stored kind — the rules extractor, an unsure model, every
 * commitment stored before this — the heuristic answers as before.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { Command, Commitment, TimeSpec } from '../../src/domain/stateMachine.ts';
import { createEmptyDomainState, normalizeStoredTimeSpec } from '../../src/domain/stateMachine.ts';
import { applyCommand, configureCommandService } from '../../lib/services/commandService.ts';
import { applyEditToCommands } from '../../lib/services/captureBoundary/applyEdits.ts';
import { validateExtractionResult } from '../../src/extraction/schemaValidator.ts';
import { mapExtractionToCommand, ITEM_KIND_MIN_CONFIDENCE } from '../../src/extraction/mapExtractionToCommand.ts';
import { OLLAMA_EXTRACTION_SCHEMA } from '../../src/extraction/ollamaExtractionSchema.ts';
import { readsAsEvent } from '../../src/extraction/lexicon/eventTitles.ts';
import { hasEventEnded, isEventCommitment } from '../../lib/services/commitments/eventEnded.ts';
import { isTimedFixedEvent } from '../../lib/services/nextStepPreparation.ts';
import { patchCommitment, patchTimeSpecForTest } from '../../lib/services/mobile/commitmentService.ts';
import { confirmCapture, proposeCapture, MemoryCaptureProposalStore, TransactionalCapturePersistenceAdapter } from '../../lib/services/captureBoundary/index.ts';
import { readRuntimeControls } from '../../src/contracts/v1/runtimeControls.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { proposeMobileCapture, clarifyMobileCapture } from '../../lib/services/mobile/mobileCaptureService.ts';
import { createStorageCaptureProposalStore } from '../../lib/services/captureBoundary/proposalStore.ts';
import { seedLiveAccount } from '../support/liveAccount.ts';

const TZ = 'Asia/Jerusalem';
const NOW = new Date('2026-11-12T13:00:00.000Z');
const context = { now: new Date('2026-11-12T08:00:00.000Z'), timezone: TZ };

function modelSaid(extra: Record<string, unknown>, rawText = 'أشتري دوا الساعة 5') {
  return validateExtractionResult(
    {
      kind: 'commitment',
      type: 'task',
      action: 'أشتري دوا',
      title: 'أشتري دوا',
      person: null,
      dueAt: '2026-11-12T15:00:00.000Z',
      remindAt: '2026-11-12T15:00:00.000Z',
      localTimeSpec: { date: '2026-11-12', time: '17:00', timezone: TZ },
      priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureImplied: false },
      flexibility: 'movable',
      category: null,
      categoryConfidence: 0,
      confidence: { overall: 0.9, type: 0.9, action: 0.9, time: 0.9, priority: 0.8 },
      missingFields: [],
      ambiguityFlags: [],
      explicitReminderRequest: false,
      explicitPressureRequest: false,
      ...extra,
    },
    rawText,
    context,
  );
}

function storedSpec(extraction: ReturnType<typeof modelSaid>): Partial<TimeSpec> {
  const [command] = mapExtractionToCommand(extraction, context.now.toISOString());
  assert.ok(command && command.type === 'CreateDraft');
  return command.commitment.timeSpec ?? {};
}

function at(timeSpec: Partial<TimeSpec>, title: string): Pick<Commitment, 'timeSpec' | 'title' | 'postponedUntil'> {
  return {
    title,
    postponedUntil: null,
    timeSpec: {
      kind: 'scheduled_event',
      dueAt: '2026-11-12T07:00:00.000Z',
      endAt: null,
      remindAt: null,
      allDay: false,
      timezone: TZ,
      ...timeSpec,
    },
  };
}

// ── the schema and the validator ─────────────────────────────────────────

test('the schema asks the model whether the item is an event or a task, and how sure it is', () => {
  const property = OLLAMA_EXTRACTION_SCHEMA.properties.itemKind;
  assert.deepEqual([...property.enum], ['event', 'task']);
  assert.deepEqual([...property.type], ['string', 'null']);
  assert.equal(OLLAMA_EXTRACTION_SCHEMA.properties.itemKindConfidence.type, 'number');
  assert.ok((OLLAMA_EXTRACTION_SCHEMA.required as readonly string[]).includes('itemKind'));
});

test('an event or a task is read off the model answer with its confidence', () => {
  const event = modelSaid({ itemKind: 'event', itemKindConfidence: 0.92 });
  assert.equal(event.itemKind, 'event');
  assert.equal(event.itemKindConfidence, 0.92);
  const task = modelSaid({ itemKind: 'task', itemKindConfidence: 1.4 });
  assert.equal(task.itemKind, 'task');
  assert.equal(task.itemKindConfidence, 1);
});

test('a kind the model invented, or none, reads as unknown with no confidence', () => {
  for (const extra of [{ itemKind: 'meeting', itemKindConfidence: 0.99 }, {}, { itemKind: null, itemKindConfidence: 0.8 }]) {
    const result = modelSaid(extra);
    assert.equal(result.itemKind ?? null, null);
    assert.equal(result.itemKindConfidence ?? 0, 0);
  }
});

// ── stored on the commitment ─────────────────────────────────────────────

test('a confident kind is stored on the commitment', () => {
  assert.equal(storedSpec(modelSaid({ itemKind: 'event', itemKindConfidence: 0.95 })).itemKind, 'event');
  assert.equal(storedSpec(modelSaid({ itemKind: 'task', itemKindConfidence: 0.95 })).itemKind, 'task');
});

test('a kind below the floor is not stored, so the heuristic answers', () => {
  const unsure = storedSpec(modelSaid({ itemKind: 'event', itemKindConfidence: ITEM_KIND_MIN_CONFIDENCE - 0.01 }));
  assert.equal('itemKind' in unsure, false);
  const atFloor = storedSpec(modelSaid({ itemKind: 'event', itemKindConfidence: ITEM_KIND_MIN_CONFIDENCE }));
  assert.equal(atFloor.itemKind, 'event');
});

test('a stored kind survives the read path, and garbage is dropped', () => {
  const base = { kind: 'scheduled_event' as const, dueAt: '2026-11-12T07:00:00.000Z', timezone: TZ };
  assert.equal(normalizeStoredTimeSpec({ ...base, itemKind: 'event' }).itemKind, 'event');
  assert.equal(normalizeStoredTimeSpec({ ...base, itemKind: 'task' }).itemKind, 'task');
  const junk = normalizeStoredTimeSpec({ ...base, itemKind: 'meeting' as never });
  assert.equal('itemKind' in junk, false);
});

test('moving a commitment keeps its kind', () => {
  const current = normalizeStoredTimeSpec({ kind: 'scheduled_event', dueAt: '2026-11-12T07:00:00.000Z', timezone: TZ, itemKind: 'task' });
  const patched = patchTimeSpecForTest(current, { dueDate: '2026-11-13T07:00:00.000Z' }, NOW);
  assert.equal(patched?.itemKind, 'task');
});

// ── the stored kind wins over the title ──────────────────────────────────

test('readsAsEvent: the stored kind wins, the title answers only when there is none', () => {
  assert.equal(readsAsEvent('task', 'اجتماع مع سامي'), false);
  assert.equal(readsAsEvent('event', 'أشتري دوا'), true);
  assert.equal(readsAsEvent(undefined, 'اجتماع مع سامي'), true);
  assert.equal(readsAsEvent(undefined, 'أشتري دوا'), false);
});

test('a meeting-titled item the model called a task is not an event, and keeps #383', () => {
  const item = at({ itemKind: 'task' }, 'اجتماع مع سامي');
  assert.equal(isEventCommitment(item), false);
  assert.equal(hasEventEnded(item, NOW), false);
});

test('an item the model called an event ends an hour after it starts, whatever its title', () => {
  const item = at({ itemKind: 'event' }, 'محمد عند الحلاق');
  assert.equal(isEventCommitment(item), true);
  assert.equal(hasEventEnded(item, NOW), true);
});

test('a work block with an end that the model called a task is not an event', () => {
  const block = at({ endAt: '2026-11-12T09:00:00.000Z', itemKind: 'task' }, 'أشتغل على التقرير');
  assert.equal(isEventCommitment(block), false);
});

test('an all-day item stays an event even when the model called it a task', () => {
  // `isAllDayEventSpec` says so to every surface already; one predicate
  // disagreeing with it would split the day plan from the lists.
  const day = at({ dueAt: '2026-11-11T22:00:00.000Z', allDay: true, itemKind: 'task' }, 'موعد دكتور');
  assert.equal(isEventCommitment(day), true);
});

test('a deadline is never an event, whatever the model said', () => {
  assert.equal(isEventCommitment(at({ kind: 'due_by', itemKind: 'event' }, 'اجتماع مع سامي')), false);
});

test('no stored kind: the title heuristic answers as before', () => {
  assert.equal(isEventCommitment(at({}, 'اجتماع مع سامي')), true);
  assert.equal(isEventCommitment(at({}, 'أشتري دوا')), false);
});

test('the next step reads the stored kind too', () => {
  const asCommitment = (spec: Partial<TimeSpec>, title: string) => at(spec, title) as unknown as Commitment;
  assert.equal(isTimedFixedEvent(asCommitment({ itemKind: 'task' }, 'اجتماع مع سامي')), false);
  assert.equal(isTimedFixedEvent(asCommitment({ itemKind: 'event' }, 'محمد عند الحلاق')), true);
  assert.equal(isTimedFixedEvent(asCommitment({}, 'اجتماع مع سامي')), true);
});

// ── a new title is new words: the model's answer was about the old ones ──
//
// Review of the classification (2026-11-14): «اجتماع مع سامي» read as an event,
// retitled «أبعت ملخص الاجتماع لسامي», would still leave Today an hour after
// its time. A task read as an event is the one mistake that loses work, so a
// retitle drops the model's answer. It is still an item capture made, so it
// becomes `unsure` (owner decision 2026-11-14, option 2): never hidden, and
// the title is not guessed at.

const RETITLE_ID = 'cmt_item_kind_retitle';

function seedEvent(): void {
  configureCommandService({ initialState: createEmptyDomainState(), schedulerStore: null });
  applyCommand({
    type: 'CreateDraft',
    now: '2026-11-10T08:00:00.000Z',
    commitment: {
      id: RETITLE_ID,
      kind: 'task',
      title: 'اجتماع مع سامي',
      priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
      timeSpec: { kind: 'scheduled_event', dueAt: '2026-11-13T10:00:00.000Z', remindAt: null, timezone: TZ, itemKind: 'event' },
    },
    draftStatus: 'pending_confirmation',
  } as Command);
  applyCommand({ type: 'ConfirmCommitment', commitmentId: RETITLE_ID, now: '2026-11-10T08:01:00.000Z' } as Command);
}

test('a retitled commitment drops the stored kind and becomes unsure', async () => {
  seedEvent();
  const patched = await patchCommitment(RETITLE_ID, { title: 'اجتماع تاني مع سامي' }, NOW);
  assert.equal(patched.timeSpec.itemKind, 'unsure');
  assert.equal(isEventCommitment(patched), false);
});

test('a patch that keeps the title keeps the stored kind', async () => {
  seedEvent();
  const same = await patchCommitment(RETITLE_ID, { title: 'اجتماع مع سامي', dueDate: '2026-11-14T10:00:00.000Z' }, NOW);
  assert.equal(same.timeSpec.itemKind, 'event');
});

test('a title edited on the review card drops the stored kind too', () => {
  const [draft] = mapExtractionToCommand(modelSaid({ itemKind: 'event', itemKindConfidence: 0.95 }), context.now.toISOString());
  assert.ok(draft && draft.type === 'CreateDraft');
  const [edited] = applyEditToCommands([draft], { title: 'أشتري دوا للبيت' });
  assert.ok(edited && edited.type === 'CreateDraft');
  assert.equal(edited.commitment.timeSpec?.itemKind, 'unsure');
  const [sameTitle] = applyEditToCommands([draft], { title: draft.commitment.title });
  assert.ok(sameTitle && sameTitle.type === 'CreateDraft');
  assert.equal(sameTitle.commitment.timeSpec?.itemKind, 'event');
  const [kept] = applyEditToCommands([draft], { priority: 'high' });
  assert.ok(kept && kept.type === 'CreateDraft');
  assert.equal(kept.commitment.timeSpec?.itemKind, 'event');
});

// ── no answer from the model on a new capture: unsure, never hidden ──────
//
// Round-4 review of #841 (2026-11-14): when the model gives no confident
// answer — rules fallback, quota, an error, a low confidence — the title
// heuristic decided, and it hides tasks: «أذاكر من 3 لـ 5» has an end, and
// "Exam prep" names an exam. Owner decision, option 2: an item capture makes
// from now on carries `itemKind: 'unsure'` instead, which is never an event.
// Items with no `itemKind` at all — made before capture-v7, or by Gmail,
// fixtures and the other paths — keep the heuristic, so stored meetings still
// leave Today when they end.

const CAPTURE_NOW = new Date('2026-08-17T08:00:00.000Z');

function unclassified(overrides: Record<string, unknown> = {}) {
  return {
    type: 'task' as const,
    action: 'Exam prep',
    title: 'Exam prep',
    person: null,
    dueAt: '2026-08-17T12:00:00.000Z',
    remindAt: '2026-08-17T12:00:00.000Z',
    localTimeSpec: { date: '2026-08-17', time: '12:00', timezone: 'UTC' },
    timeEvidence: 'hhmm' as const,
    timeAnchor: 'event' as const,
    priority: { level: 'normal' as const, source: 'default' as const, pressureAllowed: false, pressureImplied: false },
    flexibility: 'movable' as const,
    category: null,
    categoryConfidence: 0,
    confidence: { overall: 0.95, type: 0.95, action: 0.95, time: 0.95, priority: 0.8 },
    missingFields: [],
    ambiguityFlags: [],
    explicitReminderRequest: true,
    explicitPressureRequest: false,
    rawText: 'Exam prep at noon',
    parserVersion: 'test-v1',
    ...overrides,
  };
}

function captureHarness() {
  return {
    store: new MemoryCaptureProposalStore(),
    persistence: new TransactionalCapturePersistenceAdapter(createEmptyDomainState()),
  };
}

function draftSpec(commands: readonly Command[] | undefined): Partial<TimeSpec> {
  const draft = (commands ?? []).find((command) => command.type === 'CreateDraft');
  assert.ok(draft && draft.type === 'CreateDraft', 'expected a draft');
  return draft.commitment.timeSpec ?? {};
}

test('unsure survives the read path', () => {
  const spec = normalizeStoredTimeSpec({ kind: 'scheduled_event', dueAt: '2026-11-12T07:00:00.000Z', timezone: TZ, itemKind: 'unsure' });
  assert.equal(spec.itemKind, 'unsure');
});

test('an unsure item is never an event, whatever its title or end', () => {
  assert.equal(readsAsEvent('unsure', 'اجتماع مع سامي'), false);
  const prep = at({ itemKind: 'unsure' }, 'Exam prep');
  assert.equal(isEventCommitment(prep), false);
  assert.equal(hasEventEnded(prep, NOW), false);
  const block = at({ itemKind: 'unsure', endAt: '2026-11-12T09:00:00.000Z' }, 'أذاكر');
  assert.equal(isEventCommitment(block), false);
  assert.equal(hasEventEnded(block, NOW), false);
  const asCommitment = at({ itemKind: 'unsure' }, 'اجتماع مع سامي') as unknown as Commitment;
  assert.equal(isTimedFixedEvent(asCommitment), false);
  // All-day stays an event, as for a stored task.
  assert.equal(isEventCommitment(at({ allDay: true, itemKind: 'unsure' }, 'Exam prep')), true);
});

test('outside capture, an unclassified reading still stores no kind', () => {
  assert.equal('itemKind' in storedSpec(modelSaid({})), false);
});

test('capture: a model reading with no kind stores unsure', async () => {
  const dependencies = captureHarness();
  const proposal = await proposeCapture('Exam prep at noon', { now: CAPTURE_NOW, timezone: 'UTC', scopeId: 'a' }, {
    ...dependencies,
    extractor: async () => ({ result: unclassified(), engine: 'ollama', fallbackReason: null }),
  } as never);
  const stored = await dependencies.store.get(proposal.proposalId);
  assert.equal(draftSpec(stored?.commandsByItemId.get(proposal.items[0]!.itemId)).itemKind, 'unsure');
});

test('capture: a kind below the floor stores unsure, a confident one is kept', async () => {
  for (const [said, expected] of [
    [{ itemKind: 'event', itemKindConfidence: ITEM_KIND_MIN_CONFIDENCE - 0.1 }, 'unsure'],
    [{ itemKind: 'event', itemKindConfidence: 0.95 }, 'event'],
    [{ itemKind: 'task', itemKindConfidence: 0.95 }, 'task'],
  ] as const) {
    const dependencies = captureHarness();
    const proposal = await proposeCapture('Exam prep at noon', { now: CAPTURE_NOW, timezone: 'UTC', scopeId: 'a' }, {
      ...dependencies,
      extractor: async () => ({ result: unclassified(said), engine: 'ollama', fallbackReason: null }),
    } as never);
    const stored = await dependencies.store.get(proposal.proposalId);
    assert.equal(draftSpec(stored?.commandsByItemId.get(proposal.items[0]!.itemId)).itemKind, expected);
  }
});

test('capture: the rules fallback stores unsure, and the confirmed task stays on Today', async () => {
  const dependencies = captureHarness();
  const proposal = await proposeCapture('Exam prep from 3pm to 5pm', { now: CAPTURE_NOW, timezone: 'UTC', scopeId: 'a' }, {
    ...dependencies,
    controls: readRuntimeControls({ MAYBESITTER_KILL_SWITCH_CAPTURE: 'true' }),
    llmProvider: async () => { throw new Error('must not execute'); },
  } as never);
  assert.equal(proposal.provenance.executedEngine, 'rule-based');
  const item = proposal.items[0]!;
  const stored = await dependencies.store.get(proposal.proposalId);
  assert.equal(draftSpec(stored?.commandsByItemId.get(item.itemId)).itemKind, 'unsure');
  const confirmed = await confirmCapture(
    { proposalId: proposal.proposalId, scopeId: 'a', selectedItemIds: [item.itemId], idempotencyKey: 'unsure-rules', now: CAPTURE_NOW },
    dependencies as never,
  );
  assert.equal(confirmed.success, true);
  const [commitment] = Object.values((await dependencies.persistence.snapshot()).commitments);
  assert.equal(commitment?.timeSpec.itemKind, 'unsure');
  assert.equal(hasEventEnded(commitment!, new Date('2026-08-17T23:00:00.000Z')), false);
});

test('capture: an item finished by hand at confirm stores unsure', async () => {
  const dependencies = captureHarness();
  const proposal = await proposeCapture('Exam prep', { now: CAPTURE_NOW, timezone: 'UTC', scopeId: 'a' }, {
    ...dependencies,
    extractor: async () => ({
      result: unclassified({ dueAt: null, remindAt: null, localTimeSpec: null, timeEvidence: 'none', missingFields: ['time'] }),
      engine: 'ollama',
      fallbackReason: null,
    }),
  } as never);
  const item = proposal.items[0]!;
  assert.equal(item.needsClarification, true);
  const confirmed = await confirmCapture({
    proposalId: proposal.proposalId,
    scopeId: 'a',
    selectedItemIds: [item.itemId],
    idempotencyKey: 'unsure-manual',
    now: CAPTURE_NOW,
    edits: [{ itemId: item.itemId, title: 'Exam prep', resolvedTime: '2026-08-17T15:00:00.000Z' }],
  } as never, dependencies as never);
  assert.equal(confirmed.success, true);
  const [commitment] = Object.values((await dependencies.persistence.snapshot()).commitments);
  assert.equal(commitment?.timeSpec.itemKind, 'unsure');
});

test('capture: an answered question stores unsure when the model never classified it', async () => {
  setStorageForTests(createMemoryStorage());
  try {
    const UID = 'ItemKindClarifyUser';
    const ZONE = 'Asia/Jerusalem';
    const AT = '2026-09-13T06:00:00.000Z';
    await seedLiveAccount(UID);
    const proposal = await proposeMobileCapture({ text: 'Remind me to call Dana', timezone: ZONE, referenceTime: AT }, { participantId: UID });
    const item = proposal.items.find((candidate) => candidate.needsClarification && candidate.clarification);
    assert.ok(item);
    const question = item.clarification!;
    const option = question.options.find((candidate) => candidate.value.localTime) ?? question.options[0]!;
    await clarifyMobileCapture(
      { proposalId: proposal.proposalId, itemId: item.itemId, questionId: question.questionId, optionId: option.optionId, timezone: ZONE, referenceTime: AT },
      { participantId: UID },
    );
    const stored = await createStorageCaptureProposalStore().get(proposal.proposalId);
    assert.equal(draftSpec(stored?.commandsByItemId.get(item.itemId)).itemKind, 'unsure');
  } finally {
    resetStorageForTests();
  }
});
