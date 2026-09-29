/**
 * The owner's live capture defects of 2026-09-29, replayed (lane FIX-R8-CAPTURE).
 *
 *   1  «عندي تدريب كل سبت من الساعة 10 لـ 4» became ONE event today (Tue 29/09)
 *      at 10:00, already past, titled «عندي تدريب كل سبت»: «سبت» without «ال»
 *      was no weekday, the clock alone fell back to today, «كل» meant nothing.
 *   2  «יש לי התמחות כל שבת מ-10 עד 4» became a Saturday 04:00 *deadline*: the
 *      hyphen in «מ-10» broke the Hebrew range, so «עד 4» was read alone.
 *   3  «عندي دوام كل يوم سبت من 10 للـ 4» (tatweel) and "internship every
 *      Saturday 10 to 4" (no "from") broke their ranges; no range ever kept
 *      its end.
 *   4  «ذكرني بخطبة صاحبي الاول يوم الجمعة عال ٤ والثاني الحنعة عال٦» was one
 *      item. Two engagements: Friday at 4 (صبح/مسا asked), and the second's
 *      day asked — «الحنعة» is a typo, not Friday, and never today — with its
 *      6 asked صبح/مسا too.
 *
 * Binding rules: nothing picks or moves a date or an hour silently; a passed
 * time is asked; nothing is saved without the person's confirm.
 *
 * Both engines: the rules through `proposeMobileCapture` (no AI consent), the
 * model through `proposeCapture` + `guardedMobileExtract` with a stubbed
 * provider answering what a model plausibly answers — today or tomorrow for
 * «كل سبت», Friday for the typo.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LLMUnavailableError } from '../../src/extraction/llm/llmProvider.ts';
import { MemoryCaptureProposalStore, proposeCapture, TransactionalCapturePersistenceAdapter } from '../../lib/services/captureBoundary/index.ts';
import { guardedMobileExtract } from '../../lib/services/mobile/safety.ts';
import { clarifyMobileCapture, confirmMobileCapture, proposeMobileCapture } from '../../lib/services/mobile/mobileCaptureService.ts';
import { getParticipantStateSnapshot } from '../../lib/services/mobile/participantState.ts';
import { createEmptyDomainState, type Commitment } from '../../src/domain/stateMachine.ts';
import { localTimeSpecFor, instantFromLocal } from '../../src/extraction/timeLexicon.ts';
import { splitCaptureClauses } from '../../src/extraction/clauseSplitter.ts';
import { extract } from '../../src/extraction/ruleBasedExtractor.ts';

const TZ = 'Asia/Jerusalem';
/** Tuesday 29 Sep 2026, 11:00 in Jerusalem — when the owner typed them. */
const TUE = new Date('2026-09-29T08:00:00.000Z');
/** Saturday 3 Oct 2026, 08:00 in Jerusalem — before the Saturday session starts. */
const SAT = new Date('2026-10-03T05:00:00.000Z');

const TRAINING = 'عندي تدريب كل سبت من الساعة 10 لـ 4';
const INTERNSHIP_HE = 'יש לי התמחות כל שבת מ-10 עד 4';
const SHIFT_TATWEEL = 'عندي دوام كل يوم سبت من 10 للـ 4';
const INTERNSHIP_EN = 'internship every Saturday 10 to 4';
const ENGAGEMENTS = 'ذكرني بخطبة صاحبي الاول يوم الجمعة عال ٤ والثاني الحنعة عال٦';

type Item = {
  itemId: string;
  title: string;
  resolvedDate?: string;
  dateEstimated?: boolean;
  resolvedTime: string | null;
  needsClarification: boolean;
  recurrenceHint?: { weekdays: number[]; start?: string; end?: string } | null;
  clarification?: { questionId: string; questionKey?: string; allowFreeText?: boolean; options: Array<{ optionId: string; value: { localDate?: string; localTime?: string } }> } | null;
};
const local = (iso: string | null) => (iso ? localTimeSpecFor(new Date(iso), TZ)?.time ?? null : null);
const line = (item: Item) => `${item.title} | ${item.resolvedDate ?? '-'}${item.dateEstimated ? '~' : ''} ${local(item.resolvedTime) ?? '-'} | ${item.needsClarification ? item.clarification?.questionKey ?? 'edit' : 'settled'}`;
const offered = (item: Item) => (item.clarification?.options ?? []).map((option) => `${option.optionId} ${option.value.localDate ?? '-'} ${option.value.localTime ?? '-'}`);

let uidCounter = 0;
const nextUid = () => `fix-r8-${uidCounter += 1}`;

async function rules(text: string, now: Date, uid = nextUid()) {
  const proposal = await proposeMobileCapture({ text, timezone: TZ, referenceTime: now.toISOString() }, { participantId: uid });
  return { proposal, items: proposal.items as Item[], uid };
}

async function confirmedCommitments(uid: string, proposalId: string, itemIds: string[]): Promise<Commitment[]> {
  await confirmMobileCapture({ proposalId, itemIds }, { participantId: uid });
  return Object.values((await getParticipantStateSnapshot(uid)).commitments);
}

/** A model answer for one clause, as the batch and single prompts expect it. */
function modelItem(fields: { title: string; date?: string | null; time?: string | null; type?: string }) {
  const date = fields.date ?? null;
  const time = fields.time ?? null;
  const instant = date && time ? instantFromLocal(date, time, TZ)!.toISOString() : null;
  return {
    type: fields.type ?? 'task',
    action: fields.title,
    title: fields.title,
    person: null,
    dueAt: instant,
    remindAt: instant,
    localTimeSpec: date ? { date, time, timezone: TZ } : null,
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureImplied: false },
    flexibility: 'movable',
    category: null,
    categoryConfidence: 0,
    confidence: { overall: 0.9, type: 1, action: 1, time: 0.9, priority: 1 },
    missingFields: [],
    ambiguityFlags: [],
    explicitReminderRequest: false,
    explicitPressureRequest: false,
  };
}

function payloadOf(prompt: string): string | string[] {
  const lines = prompt.split('\n');
  return JSON.parse(lines[lines.indexOf('BEGIN_UNTRUSTED_USER_MESSAGE') + 1]!) as string | string[];
}

/** A model that answers each clause with `answers[clause]`; anything else is unavailable. */
function stubModel(answers: Record<string, ReturnType<typeof modelItem>>) {
  return async (prompt: string): Promise<string> => {
    const payload = payloadOf(prompt);
    if (Array.isArray(payload)) {
      return JSON.stringify({ items: payload.map((clause, clauseIndex) => {
        const answer = answers[clause];
        if (!answer) throw new LLMUnavailableError('provider_error');
        return { clauseIndex, ...answer };
      }) });
    }
    const answer = answers[payload];
    if (!answer) throw new LLMUnavailableError('provider_error');
    return JSON.stringify(answer);
  };
}

async function model(text: string, now: Date, answers: Record<string, ReturnType<typeof modelItem>>) {
  const store = new MemoryCaptureProposalStore();
  const persistence = new TransactionalCapturePersistenceAdapter(createEmptyDomainState());
  const contract = await proposeCapture(
    text,
    { now, timezone: TZ, scopeId: 'fix-r8-model', requestedEngine: 'model' },
    { store, persistence, extractor: guardedMobileExtract, llmProvider: stubModel(answers), llmEngine: 'gemini' },
  );
  return { contract, items: contract.items as Item[] };
}

// ── 1–3: a weekly session with a range, in all three languages ──────────

for (const [label, text, title] of [
  ['1 ar «كل سبت» + «من الساعة 10 لـ 4»', TRAINING, 'عندي تدريب كل سبت'],
  ['2 he «כל שבת» + «מ-10 עד 4»', INTERNSHIP_HE, 'יש לי התמחות כל שבת'],
  ['3 ar «كل يوم سبت» + «من 10 للـ 4» (tatweel)', SHIFT_TATWEEL, 'عندي دوام كل يوم سبت'],
  ['3 en "every Saturday 10 to 4"', INTERNSHIP_EN, 'internship every Saturday'],
] as const) {
  test(`FIX-R8 ${label}: the next Saturday, 10:00–16:00, marked ours, never today`, async () => {
    const { proposal, items, uid } = await rules(text, TUE);
    assert.deepEqual(items.map(line), [`${title} | 2026-10-03~ 10:00 | settled`]);
    assert.deepEqual(items[0]!.recurrenceHint, { weekdays: [6], start: '10:00', end: '16:00' });
    // Nothing is saved until the person confirms; confirmed, it is an event
    // with the end the words gave — not a deadline at 04:00.
    assert.deepEqual(Object.values((await getParticipantStateSnapshot(uid)).commitments), []);
    const [commitment] = await confirmedCommitments(uid, proposal.proposalId, [items[0]!.itemId]);
    assert.equal(commitment!.timeSpec.kind, 'scheduled_event');
    assert.equal(local(commitment!.timeSpec.dueAt), '10:00');
    assert.equal(localTimeSpecFor(new Date(commitment!.timeSpec.endAt!), TZ)?.date, '2026-10-03');
    assert.equal(local(commitment!.timeSpec.endAt), '16:00');
    assert.equal(commitment!.title, title);
  });
}

test('FIX-R8 1: on a Saturday morning, «كل سبت» is next Saturday — never a one-off today', async () => {
  for (const text of [TRAINING, INTERNSHIP_HE, SHIFT_TATWEEL, INTERNSHIP_EN]) {
    const { items } = await rules(text, SAT);
    assert.equal(items.length, 1, text);
    assert.equal(items[0]!.resolvedDate, '2026-10-10', text);
    assert.equal(items[0]!.dateEstimated, true, text);
    assert.equal(local(items[0]!.resolvedTime), '10:00', text);
  }
});

test('FIX-R8 1: the frames that make a bare day word a day, and the ones that do not', () => {
  const day = (text: string) => extract(text, { now: TUE, timezone: TZ }).localTimeSpec?.date ?? null;
  assert.equal(day('عندي درس يوم سبت الساعة 10'), '2026-10-03');
  assert.equal(day('عندي درس كل خميس الساعة 10'), '2026-10-01');
  assert.equal(day('عندي درس يوم جمعة الساعة 10'), '2026-10-02');
  // «كل أحد» is "everyone", «كل اثنين» "every two": no Sunday, no Monday.
  assert.notEqual(day('بدي أحكي مع كل أحد الساعة 10'), '2026-10-04');
  assert.notEqual(day('بدي أشتري كل اثنين الساعة 10'), '2026-10-05');
});

test('FIX-R8 1: a range ends after it starts, whichever half the start is asked into', async () => {
  // «من 2 لـ 4»: the 2 is asked صبح/مسا (CL1 round 6); the end follows it.
  const { proposal, items, uid } = await rules('عندي تدريب بكرا من 2 لـ 4', TUE);
  assert.deepEqual(items.map(line), ['عندي تدريب | 2026-09-30 - | ask_am_pm']);
  const pm = items[0]!.clarification!.options.find((option) => option.optionId === 'pm')!;
  await clarifyMobileCapture({ proposalId: proposal.proposalId, itemId: items[0]!.itemId, questionId: items[0]!.clarification!.questionId, optionId: pm.optionId, timezone: TZ, referenceTime: TUE.toISOString() }, { participantId: uid });
  const [commitment] = await confirmedCommitments(uid, proposal.proposalId, [items[0]!.itemId]);
  assert.equal(local(commitment!.timeSpec.dueAt), '14:00');
  assert.equal(local(commitment!.timeSpec.endAt), '16:00');
  // An end with its own half: «من 10 لـ 4 المسا» is 10:00–16:00, not 22:00.
  const evening = await rules('عندي تدريب بكرا من 10 لـ 4 المسا', TUE);
  assert.equal(local(evening.items[0]!.resolvedTime), '10:00');
  // "buy 2 to 4 apples" is no range, and «5 to 10 minutes» no clock.
  assert.equal(extract('buy 2 to 4 apples tomorrow', { now: TUE, timezone: TZ }).localTimeSpec?.time ?? null, null);
});

test('FIX-R8 2: «עד 4» inside a range is not a deadline', async () => {
  const result = extract(INTERNSHIP_HE, { now: TUE, timezone: TZ });
  assert.equal(result.timeAnchor, 'event');
  assert.equal(result.localTimeSpec?.time, '10:00');
});

test('FIX-R8 1: «كل أسبوع» with no day and a clock — the day is asked, never today', async () => {
  const { items } = await rules('عندي اجتماع كل أسبوع الساعة 10', TUE);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.resolvedDate, undefined);
  assert.equal(items[0]!.clarification?.questionKey, 'ask_day');
  assert.deepEqual(items[0]!.recurrenceHint, { weekdays: [] });
  assert.equal(items[0]!.title, 'عندي اجتماع كل أسبوع');
  // The rules reader on its own already keeps the hour with no day: a clock
  // alone is today only when no recurrence was said.
  const read = extract('عندي اجتماع كل أسبوع الساعة 10', { now: TUE, timezone: TZ });
  assert.equal(read.localTimeSpec, null);
  assert.equal(read.dueAt, null);
  assert.equal(read.undatedTime, '10:00');
  assert.equal(extract('عندي اجتماع الساعة 12', { now: TUE, timezone: TZ }).localTimeSpec?.date, '2026-09-29');
});

// ── 4: the owner's two engagements ───────────────────────────────────────

test('FIX-R8 4: «…الاول يوم الجمعة عال ٤ والثاني الحنعة عال٦» is two items; the second day is asked', async () => {
  assert.deepEqual(splitCaptureClauses(ENGAGEMENTS), [
    'ذكرني بخطبة صاحبي الاول يوم الجمعة عال ٤',
    'ذكرني بخطبة صاحبي الثاني الحنعة عال٦',
  ]);
  const { items } = await rules(ENGAGEMENTS, TUE);
  assert.deepEqual(items.map(line), [
    'خطبة صاحبي الاول | 2026-10-02~ - | ask_am_pm',
    // No day: not Friday by any likeness to «الجمعة», and not today.
    'خطبة صاحبي الثاني | - - | ask_day',
  ]);
  assert.deepEqual(offered(items[0]!), ['am 2026-10-02 04:00', 'pm 2026-10-02 16:00']);
  // No day buttons: each would carry a half of the day nobody chose.
  assert.deepEqual(offered(items[1]!), []);
  assert.equal(items[1]!.clarification?.allowFreeText, true);
});

test('FIX-R8 4: the second is answered «الجمعة», then asked صبح/مسا about its 6; both confirm', async () => {
  const { proposal, items, uid } = await rules(ENGAGEMENTS, TUE);
  const second = items[1]!;
  const afterDay = await clarifyMobileCapture({ proposalId: proposal.proposalId, itemId: second.itemId, questionId: second.clarification!.questionId, freeText: 'الجمعة', timezone: TZ, referenceTime: TUE.toISOString() }, { participantId: uid });
  const placed = afterDay.items.find((item) => item.itemId === second.itemId) as Item;
  assert.equal(line(placed), 'خطبة صاحبي الثاني | 2026-10-02 - | ask_am_pm');
  assert.deepEqual(offered(placed), ['am 2026-10-02 06:00', 'pm 2026-10-02 18:00']);
  assert.equal(placed.clarification?.allowFreeText, false);
  await clarifyMobileCapture({ proposalId: proposal.proposalId, itemId: second.itemId, questionId: placed.clarification!.questionId, optionId: 'pm', timezone: TZ, referenceTime: TUE.toISOString() }, { participantId: uid });
  await clarifyMobileCapture({ proposalId: proposal.proposalId, itemId: items[0]!.itemId, questionId: items[0]!.clarification!.questionId, optionId: 'pm', timezone: TZ, referenceTime: TUE.toISOString() }, { participantId: uid });
  const commitments = await confirmedCommitments(uid, proposal.proposalId, [items[0]!.itemId, second.itemId]);
  assert.deepEqual(
    commitments.map((commitment) => `${commitment.title} ${localTimeSpecFor(new Date(commitment.timeSpec.dueAt!), TZ)?.date} ${local(commitment.timeSpec.dueAt)}`).sort(),
    ['خطبة صاحبي الاول 2026-10-02 16:00', 'خطبة صاحبي الثاني 2026-10-02 18:00'],
  );
});

test('FIX-R8 4: a day with its half settles the 6 in one answer; a half with no day is not understood', async () => {
  const { proposal, items, uid } = await rules(ENGAGEMENTS, TUE);
  const second = items[1]!;
  await assert.rejects(
    clarifyMobileCapture({ proposalId: proposal.proposalId, itemId: second.itemId, questionId: second.clarification!.questionId, freeText: 'المسا', timezone: TZ, referenceTime: TUE.toISOString() }, { participantId: uid }),
    (error: unknown) => (error as { failure?: string }).failure === 'answer_not_understood',
  );
  const answered = await clarifyMobileCapture({ proposalId: proposal.proposalId, itemId: second.itemId, questionId: second.clarification!.questionId, freeText: 'السبت المسا', timezone: TZ, referenceTime: TUE.toISOString() }, { participantId: uid });
  assert.equal(line(answered.items.find((item) => item.itemId === second.itemId) as Item), 'خطبة صاحبي الثاني | 2026-10-03 18:00 | settled');
});

test('FIX-R8 4: «عال ٤», «عالساعة 4», «على الساعة ٤», «ع الساعة 4» are all a clock', () => {
  for (const clock of ['عال ٤', 'عال4', 'عالساعة 4', 'على الساعة ٤', 'ع الساعة 4']) {
    const result = extract(`عندي خطبة يوم الجمعة ${clock}`, { now: TUE, timezone: TZ });
    assert.equal(result.localTimeSpec?.time, '04:00', clock);
    assert.equal(result.timeEvidence, 'clock_marker', clock);
    assert.equal(result.title, 'عندي خطبة', clock);
  }
});

test('FIX-R8 4: «الأول والثاني» with nothing between is one item', () => {
  assert.equal(splitCaptureClauses('أدرس الفصل الأول والثاني بكرا').length, 1);
  assert.deepEqual(splitCaptureClauses('أدرس الفصل الأول بكرا والثاني بعد بكرا'), ['أدرس الفصل الأول بكرا', 'أدرس الفصل الثاني بعد بكرا']);
});

// ── The model path: the same words, the same shape ───────────────────────

test('FIX-R8 model: «كل سبت» answered as today or tomorrow is put on the next Saturday, marked ours', async () => {
  for (const [date, time] of [['2026-09-29', '10:00'], ['2026-09-30', '10:00']] as const) {
    const { items } = await model(TRAINING, TUE, { [TRAINING]: modelItem({ title: 'تدريب', date, time }) });
    assert.equal(items.length, 1, date);
    assert.equal(items[0]!.resolvedDate, '2026-10-03', date);
    assert.equal(items[0]!.dateEstimated, true, date);
    assert.equal(local(items[0]!.resolvedTime), '10:00', date);
    // The recurrence stays visible in the title the model shortened.
    assert.equal(items[0]!.title, 'تدريب كل سبت', date);
    assert.deepEqual(items[0]!.recurrenceHint, { weekdays: [6], start: '10:00', end: '16:00' });
  }
  const he = await model(INTERNSHIP_HE, TUE, { [INTERNSHIP_HE]: modelItem({ title: 'התמחות כל שבת', date: '2026-09-29', time: '10:00' }) });
  assert.equal(he.items[0]!.resolvedDate, '2026-10-03');
  assert.equal(he.items[0]!.title, 'התמחות כל שבת');
  const en = await model(INTERNSHIP_EN, SAT, { [INTERNSHIP_EN]: modelItem({ title: 'Internship', date: '2026-10-03', time: '10:00' }) });
  assert.equal(en.items[0]!.resolvedDate, '2026-10-10');
  assert.equal(en.items[0]!.title, 'Internship every Saturday');
});

test('FIX-R8 model: «كل أسبوع» answered as today has no day; the day is asked', async () => {
  const text = 'عندي اجتماع كل أسبوع الساعة 10';
  const { items } = await model(text, TUE, { [text]: modelItem({ title: 'اجتماع', date: '2026-09-29', time: '10:00' }) });
  assert.equal(items[0]!.resolvedDate, undefined);
  assert.equal(items[0]!.clarification?.questionKey, 'ask_day');
});

test('FIX-R8 model: the typo is never Friday, whatever the model says', async () => {
  const first = 'ذكرني بخطبة صاحبي الاول يوم الجمعة عال ٤';
  const second = 'ذكرني بخطبة صاحبي الثاني الحنعة عال٦';
  const { items } = await model(ENGAGEMENTS, TUE, {
    [first]: modelItem({ title: 'خطبة صاحبي الأول', date: '2026-10-02', time: '16:00' }),
    [second]: modelItem({ title: 'خطبة صاحبي الثاني', date: '2026-10-02', time: '18:00' }),
  });
  assert.deepEqual(items.map(line), [
    // The bare 4 is asked, as on the rules path (UAT round 6, D1).
    'خطبة صاحبي الأول | 2026-10-02~ - | ask_am_pm',
    'خطبة صاحبي الثاني | - - | ask_day',
  ]);
  assert.deepEqual(offered(items[1]!), []);
});
