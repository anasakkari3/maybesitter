/**
 * Only a limit the person said is a deadline in «ما اتصرّفت فيها» (owner
 * decision 2026-11-19).
 *
 * Capture writes a `due_by` for every item with a day and no hour, so «بدي
 * أدرس الثلاثاء» was listed as a missed hand-in. Capture now reads the
 * person's own words for a limit (`namesExplicitDeadline`) and stores
 * `timeSpec.deadline: 'explicit'`; the place lists a passed `due_by` only
 * with that mark. No model is asked and its prompt is unchanged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { Command, Commitment, TimeSpec } from '../../src/domain/stateMachine.ts';
import { createEmptyDomainState, normalizeStoredCommitment, normalizeStoredTimeSpec } from '../../src/domain/stateMachine.ts';
import { namesExplicitDeadline } from '../../src/extraction/explicitDeadline.ts';
import { mapExtractionToCommand } from '../../src/extraction/mapExtractionToCommand.ts';
import type { ExtractionResult } from '../../src/extraction/extractionTypes.ts';
import { applyCommand, configureCommandService } from '../../lib/services/commandService.ts';
import { applyEditToCommands } from '../../lib/services/captureBoundary/applyEdits.ts';
import { patchCommitment } from '../../lib/services/mobile/commitmentService.ts';
import { unhandledAnchor } from '../../lib/services/mobile/unhandledService.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { proposeMobileCapture, clarifyMobileCapture } from '../../lib/services/mobile/mobileCaptureService.ts';
import { createStorageCaptureProposalStore } from '../../lib/services/captureBoundary/proposalStore.ts';
import { seedLiveAccount } from '../support/liveAccount.ts';

const TZ = 'Asia/Jerusalem';

// ── The words ──────────────────────────────────────────────────────────

const LIMITS = [
  // Arabic, the owner's list.
  'لازم أسلّم التقرير قبل الخميس',
  'أخلص المشروع لحد بكرة',
  'أدفع الفاتورة لغاية آخر الشهر',
  'آخر موعد للتقديم الأحد',
  'أقصى موعد الجمعة',
  'تسليم المشروع الأحد',
  'موعد التسليم يوم الخميس',
  'أبعت الملف قبل الساعة 5',
  'قبل يوم الخميس لازم أخلص',
  'وقبل ٣ الظهر بدي أخلص', // Arabic digits, and «و» on the word
  'أبعت الملف قبل ٥', // an Arabic digit is the only time
  'ديدلاين التقرير الخميس',
  // English.
  'Submit the report by Friday',
  'Pay rent before Thursday',
  'Rent due Friday',
  'Essay is due on Monday',
  'The deadline for the form is Sunday',
  'Send it no later than Tuesday',
  'Finish the slides by the end of the week',
  'Reply by 5pm',
  'Visa form, due date Thursday',
  // Hebrew.
  'להגיש את הדוח עד יום חמישי',
  'לשלם חשבון חשמל עד סוף החודש',
  'לסיים לפני מחר',
  'דדליין לעבודה ביום ראשון',
  'הגשה של העבודה ביום שלישי',
  'לשלוח עד ה-5',
];

const NOT_LIMITS = [
  // A day and nothing else: #383's tasks.
  'بدي أدرس الثلاثاء',
  'Study on Tuesday',
  'ללמוד ביום שלישי',
  // «قبل» / "before" / «לפני» about something other than a time.
  'قبل ما أنام بدي أقرا',
  'قبل النوم بدي أقرا',
  'رحت عالدكتور قبل يومين',
  'قبل ٣ أيام حكيت معه',
  'لحد ما يخلص الشغل',
  'لازم أسلّم على جدتي الجمعة', // the verb «أسلّم» is not «تسليم»
  'Call mom before I leave',
  'Go by bus on Sunday',
  'by the way, gym Thursday',
  'Due to the rain, walk on Friday',
  'Stretch before 5 minutes of running',
  'לקרוא לפני שאני הולך לישון',
  'לחכות עד שזה נגמר',
  'להתאמן עד 5 דקות',
  '',
];

for (const text of LIMITS) {
  test(`a limit: ${text}`, () => assert.equal(namesExplicitDeadline(text), true));
}

for (const text of NOT_LIMITS) {
  test(`no limit: ${text || '(empty)'}`, () => assert.equal(namesExplicitDeadline(text), false));
}

test('anything that is not text names no limit', () => {
  for (const value of [undefined, null, 5, {}, ['by Friday']]) assert.equal(namesExplicitDeadline(value), false);
});

// ── What capture stores ────────────────────────────────────────────────

/** A day-only reading, as the model or a «بدون وقت» answer leaves it. */
function dayOnly(rawText: string, extra: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    type: 'task',
    action: 'item',
    title: 'item',
    person: null,
    dueAt: '2026-11-18T22:00:00.000Z',
    remindAt: null,
    localTimeSpec: { date: '2026-11-19', time: null, timezone: TZ },
    timeEvidence: 'day_only',
    timeAnchor: 'deadline',
    allDay: true,
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureImplied: false },
    flexibility: 'movable',
    category: null,
    categoryConfidence: 0,
    confidence: { overall: 0.95, type: 0.95, action: 0.95, time: 0.95, priority: 0.8 },
    missingFields: [],
    ambiguityFlags: [],
    explicitReminderRequest: false,
    explicitPressureRequest: false,
    rawText,
    parserVersion: 'test-v1',
    ...extra,
  } as ExtractionResult;
}

function draftSpec(commands: readonly Command[] | undefined): Partial<TimeSpec> {
  const draft = (commands ?? []).find((command) => command.type === 'CreateDraft');
  assert.ok(draft && draft.type === 'CreateDraft', 'expected a draft');
  return draft.commitment.timeSpec ?? {};
}

const CAPTURE = { capture: true } as const;

test('capture: a limit the person said is stored on the deadline', () => {
  const spec = draftSpec(mapExtractionToCommand(dayOnly('لازم أسلّم التقرير قبل الخميس'), undefined, undefined, CAPTURE));
  assert.equal(spec.kind, 'due_by');
  assert.equal(spec.deadline, 'explicit');
});

test('capture: a day alone stores no mark', () => {
  const spec = draftSpec(mapExtractionToCommand(dayOnly('بدي أدرس الثلاثاء'), undefined, undefined, CAPTURE));
  assert.equal(spec.kind, 'due_by');
  assert.equal('deadline' in spec, false);
});

test('capture: «قبل ما أنام» is not a limit', () => {
  const spec = draftSpec(mapExtractionToCommand(dayOnly('قبل ما أنام بدي أقرا'), undefined, undefined, CAPTURE));
  assert.equal('deadline' in spec, false);
});

test('capture: English and Hebrew limits are stored, a day alone is not', () => {
  for (const [text, marked] of [
    ['Submit the report by Friday', true],
    ['Study on Friday', false],
    ['להגיש את הדוח עד יום חמישי', true],
    ['ללמוד ביום חמישי', false],
  ] as const) {
    const spec = draftSpec(mapExtractionToCommand(dayOnly(text), undefined, undefined, CAPTURE));
    assert.equal(spec.deadline === 'explicit', marked, text);
  }
});

test('capture: a limit typed as the answer to «إيمتى؟» is stored too', () => {
  const spec = draftSpec(mapExtractionToCommand(dayOnly('لازم أسلّم التقرير'), undefined, undefined, { capture: true, answer: 'قبل الخميس' }));
  assert.equal(spec.deadline, 'explicit');
  const plain = draftSpec(mapExtractionToCommand(dayOnly('لازم أسلّم التقرير'), undefined, undefined, { capture: true, answer: 'الخميس' }));
  assert.equal('deadline' in plain, false);
});

test('only a due_by carries the mark: a time to be at is never a deadline', () => {
  const event = dayOnly('من 10 لحد 12 قبل الخميس', {
    dueAt: '2026-11-19T08:00:00.000Z', remindAt: '2026-11-19T08:00:00.000Z', allDay: false,
    localTimeSpec: { date: '2026-11-19', time: '10:00', timezone: TZ }, timeEvidence: 'hhmm', timeAnchor: 'event',
  });
  const spec = draftSpec(mapExtractionToCommand(event, undefined, undefined, CAPTURE));
  assert.equal(spec.kind, 'scheduled_event');
  assert.equal('deadline' in spec, false);
});

test('outside capture and email (goal steps, plan slots) nothing is marked', () => {
  const spec = draftSpec(mapExtractionToCommand(dayOnly('Submit the report by Friday')));
  assert.equal('deadline' in spec, false);
});

test('an item read off an emailed agreement is marked when the sentence names a limit (2026-11-19)', () => {
  const emailed = { emailed: true } as const;
  assert.equal(draftSpec(mapExtractionToCommand(dayOnly('سلّم التقرير لحد الخميس'), undefined, undefined, emailed)).deadline, 'explicit');
  assert.equal(draftSpec(mapExtractionToCommand(dayOnly("I'll send the report by Friday"), undefined, undefined, emailed)).deadline, 'explicit');
  assert.equal('deadline' in draftSpec(mapExtractionToCommand(dayOnly("I'll send the report Friday"), undefined, undefined, emailed)), false);
  // An email item is not a capture: no `unsure` kind is written for it.
  assert.equal('itemKind' in draftSpec(mapExtractionToCommand(dayOnly("I'll send the report by Friday"), undefined, undefined, emailed)), false);
});

test('the review card: a new title or time keeps the mark', () => {
  const commands = mapExtractionToCommand(dayOnly('لازم أسلّم التقرير قبل الخميس'), undefined, undefined, CAPTURE);
  const edited = applyEditToCommands(commands, { title: 'التقرير', resolvedTime: '2026-11-19T10:00:00.000Z' });
  assert.equal(draftSpec(edited).deadline, 'explicit');
});

// ── Stored, read and moved ─────────────────────────────────────────────

test('the read path keeps the mark and drops anything else', () => {
  const base = { kind: 'due_by' as const, dueAt: '2026-11-18T22:00:00.000Z', allDay: true, timezone: TZ };
  assert.equal(normalizeStoredTimeSpec({ ...base, deadline: 'explicit' }).deadline, 'explicit');
  for (const junk of ['yes', true, 1, 'EXPLICIT']) {
    assert.equal('deadline' in normalizeStoredTimeSpec({ ...base, deadline: junk as never }), false, String(junk));
  }
  // A commitment stored before the mark existed has none: not a deadline the person named.
  assert.equal('deadline' in normalizeStoredCommitment({ timeSpec: base } as unknown as Commitment).timeSpec, false);
});

const MOVE_ID = 'cmt_explicit_deadline_move';

test('a deadline given a new date stays a deadline', async () => {
  configureCommandService({ initialState: createEmptyDomainState(), schedulerStore: null });
  applyCommand({
    type: 'CreateDraft',
    now: '2026-11-10T08:00:00.000Z',
    commitment: {
      id: MOVE_ID,
      kind: 'task',
      title: 'التقرير',
      priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
      timeSpec: { kind: 'due_by', dueAt: '2026-11-18T22:00:00.000Z', remindAt: null, allDay: true, timezone: TZ, deadline: 'explicit' },
    },
    draftStatus: 'pending_confirmation',
  } as Command);
  applyCommand({ type: 'ConfirmCommitment', commitmentId: MOVE_ID, now: '2026-11-10T08:01:00.000Z' } as Command);
  const moved = await patchCommitment(MOVE_ID, { dueDate: '2026-11-20T10:00:00.000Z' }, new Date('2026-11-12T13:00:00.000Z'));
  assert.equal(moved.timeSpec.deadline, 'explicit');
});

// ── End to end: capture, the «بدون وقت» answer, and the place ───────────

const UID = 'explicit-deadline-owner';
const AT = '2026-11-16T08:00:00.000Z';

async function capturedNoHour(text: string): Promise<Partial<TimeSpec>> {
  setStorageForTests(createMemoryStorage());
  try {
    await seedLiveAccount(UID);
    const proposal = await proposeMobileCapture({ text, timezone: TZ, referenceTime: AT }, { participantId: UID });
    const item = proposal.items.find((candidate) => candidate.needsClarification && candidate.clarification);
    assert.ok(item, text);
    const question = item.clarification!;
    const noHour = question.options.find((option) => !option.value.localTime && !option.value.localDate);
    assert.ok(noHour, `expected a «بدون وقت» option for ${text}`);
    await clarifyMobileCapture(
      { proposalId: proposal.proposalId, itemId: item.itemId, questionId: question.questionId, optionId: noHour.optionId, timezone: TZ, referenceTime: AT },
      { participantId: UID },
    );
    const stored = await createStorageCaptureProposalStore().get(proposal.proposalId);
    return draftSpec(stored?.commandsByItemId.get(item.itemId));
  } finally {
    resetStorageForTests();
  }
}

async function capturedTyped(text: string, answer: string): Promise<Partial<TimeSpec>> {
  setStorageForTests(createMemoryStorage());
  try {
    await seedLiveAccount(UID);
    const proposal = await proposeMobileCapture({ text, timezone: TZ, referenceTime: AT }, { participantId: UID });
    const item = proposal.items.find((candidate) => candidate.needsClarification && candidate.clarification);
    assert.ok(item, text);
    await clarifyMobileCapture(
      { proposalId: proposal.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId, freeText: answer, timezone: TZ, referenceTime: AT },
      { participantId: UID },
    );
    const stored = await createStorageCaptureProposalStore().get(proposal.proposalId);
    return draftSpec(stored?.commandsByItemId.get(item.itemId));
  } finally {
    resetStorageForTests();
  }
}

function asCommitment(spec: Partial<TimeSpec>): Commitment {
  return normalizeStoredCommitment({ id: 'c', status: 'active', title: 'c', postponedUntil: null, timeSpec: spec } as unknown as Commitment);
}

/** Saturday 2026-11-21: every day named above has passed. */
const LATER = new Date('2026-11-21T10:00:00.000Z');

for (const [text, inPlace] of [
  ['لازم أسلّم التقرير قبل الخميس', true],
  ['بدي أدرس الثلاثاء', false],
  ['Submit the report by Friday', true],
  ['Study on Tuesday', false],
  ['להגיש את הדוח עד יום חמישי', true],
  ['ללמוד ביום שלישי', false],
] as const) {
  test(`end to end: «${text}» answered «بدون وقت» is ${inPlace ? '' : 'not '}in the place once its day passed`, async () => {
    const spec = await capturedNoHour(text);
    assert.equal(spec.kind, 'due_by');
    assert.equal(spec.allDay, true);
    assert.equal(spec.deadline === 'explicit', inPlace);
    assert.equal(unhandledAnchor(asCommitment(spec), LATER)?.reason ?? null, inPlace ? 'deadline_passed' : null);
  });
}

test('end to end: a limit typed as the answer is stored', async () => {
  const spec = await capturedTyped('لازم أسلّم التقرير', 'قبل الخميس الساعة 5 المسا');
  assert.equal(spec.kind, 'due_by');
  assert.equal(spec.deadline, 'explicit');
});
