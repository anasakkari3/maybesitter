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

import type { Commitment, TimeSpec } from '../../src/domain/stateMachine.ts';
import { normalizeStoredTimeSpec } from '../../src/domain/stateMachine.ts';
import { validateExtractionResult } from '../../src/extraction/schemaValidator.ts';
import { mapExtractionToCommand, ITEM_KIND_MIN_CONFIDENCE } from '../../src/extraction/mapExtractionToCommand.ts';
import { OLLAMA_EXTRACTION_SCHEMA } from '../../src/extraction/ollamaExtractionSchema.ts';
import { readsAsEvent } from '../../src/extraction/lexicon/eventTitles.ts';
import { hasEventEnded, isEventCommitment } from '../../lib/services/commitments/eventEnded.ts';
import { isTimedFixedEvent } from '../../lib/services/nextStepPreparation.ts';
import { patchTimeSpecForTest } from '../../lib/services/mobile/commitmentService.ts';

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
