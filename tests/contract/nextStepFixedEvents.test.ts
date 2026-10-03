/**
 * An exam is not «بلّش فيها» the day before; a night out is not the next step
 * nine hours early (black-box audit 2026-10-03, #2).
 *
 * The audit's literal account, on Saturday 3 October 2026 in Jerusalem:
 *
 *   12:13  «عندي امتحان رياضيات بكرا الساعة 10» → Today offered THE EXAM as
 *          «خطوتك التالية» with «بلّش فيها». No study step anywhere.
 *   12:22  «سهرة مع الصحاب الليلة 21:00» → the night out became the next
 *          step, nothing linking it to the exam the next morning.
 *
 * Both are captured here through the real rule-based capture pipeline and
 * confirmed, then the next step is asked for on every arm through
 * `getLiveNextStep`, the function the route calls (`nextStepPreparation.ts`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmMobileCapture, proposeMobileCapture } from '../../lib/services/mobile/mobileCaptureService.ts';
import { getParticipantStateSnapshot } from '../../lib/services/mobile/participantState.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { getLiveNextStep, prepareLiveNextStepDecision } from '../../lib/services/nextStepLiveService.ts';
import { namesEvent, preparationTitle } from '../../lib/services/nextStepPreparation.ts';
import { NEXT_STEP_PINNED_ARM_ENV } from '../../lib/experiments/experimentControls.ts';
import { NEXT_STEP_ARMS } from '../../src/contracts/v1/experimentContracts.ts';
import { MODULE_FEATURE_FLAG_DEFAULTS, MODULE_KILL_SWITCH_DEFAULTS } from '../../src/contracts/v1/runtimeControls.ts';
import { applyCommand, createEmptyDomainState, type Commitment, type DomainState } from '../../src/domain/stateMachine.ts';

const TZ = 'Asia/Jerusalem';
const UID = 'audit-2026-10-03';
/** 12:13 and 12:22 in Jerusalem (UTC+3), when the audit saved each sentence. */
const AT_EXAM = new Date('2026-10-03T09:13:00.000Z');
const AT_NIGHT_OUT = new Date('2026-10-03T09:22:00.000Z');
const EXAM = 'عندي امتحان رياضيات بكرا الساعة 10';
const NIGHT_OUT = 'سهرة مع الصحاب الليلة 21:00';

const controls = { version: 'v1' as const, featureFlags: { ...MODULE_FEATURE_FLAG_DEFAULTS, recommendation: true }, killSwitches: { ...MODULE_KILL_SWITCH_DEFAULTS } };

async function withMemoryStorage<T>(run: () => Promise<T>): Promise<T> {
  setStorageForTests(createMemoryStorage());
  try {
    return await run();
  } finally {
    resetStorageForTests();
  }
}

async function capture(text: string, at: Date): Promise<void> {
  const proposal = await proposeMobileCapture({ text, timezone: TZ, referenceTime: at.toISOString() }, { participantId: UID });
  assert.equal(proposal.items.length, 1, `${text}: ${JSON.stringify(proposal.items.map((item) => item.title))}`);
  assert.equal(proposal.items[0]!.clarification, undefined, `${text} asked a question`);
  const confirmed = await confirmMobileCapture({ proposalId: proposal.proposalId, itemIds: [proposal.items[0]!.itemId] }, { participantId: UID });
  assert.equal(confirmed.success, true, JSON.stringify(confirmed));
}

function byTitle(state: DomainState, fragment: string): Commitment {
  const found = Object.values(state.commitments).find((commitment) => commitment.title.includes(fragment));
  assert.ok(found, `no «${fragment}» in ${JSON.stringify(Object.values(state.commitments).map((c) => c.title))}`);
  return found;
}

function liveContext(arm: string, now: Date) {
  return {
    anonymousUserId: UID, consent: 'essential', locale: 'ar', now, controls, emitShown: false,
    emit: async () => undefined, timezone: TZ, env: { [NEXT_STEP_PINNED_ARM_ENV]: arm },
  } as never;
}

const codesOf = (proposal: Awaited<ReturnType<typeof getLiveNextStep>>) => (proposal.explanation?.evidenceCodes ?? []).map((entry) => entry.code);

test('the saved state is the audit\'s: two timed events, the exam tomorrow 10:00, the night out tonight 21:00', async () => {
  await withMemoryStorage(async () => {
    await capture(EXAM, AT_EXAM);
    await capture(NIGHT_OUT, AT_NIGHT_OUT);
    const state = await getParticipantStateSnapshot(UID);
    const exam = byTitle(state, 'امتحان');
    const night = byTitle(state, 'سهرة');
    assert.deepEqual([exam.timeSpec.kind, exam.timeSpec.dueAt, exam.timeSpec.endAt, exam.timeSpec.allDay], ['scheduled_event', '2026-10-04T07:00:00.000Z', null, false]);
    assert.deepEqual([night.timeSpec.kind, night.timeSpec.dueAt, night.timeSpec.allDay], ['scheduled_event', '2026-10-03T18:00:00.000Z', false]);
  });
});

for (const arm of NEXT_STEP_ARMS) {
  test(`#2 (${arm}): at 12:13 the next step is preparing for the exam — never the exam itself`, async () => {
    await withMemoryStorage(async () => {
      await capture(EXAM, AT_EXAM);
      const state = await getParticipantStateSnapshot(UID);
      const exam = byTitle(state, 'امتحان');
      const proposal = await getLiveNextStep(state, liveContext(arm, AT_EXAM));
      assert.equal(proposal.state, 'ready');
      assert.equal(proposal.primaryStep?.purpose, 'prepare', `the step was ${JSON.stringify(proposal.primaryStep)}`);
      assert.equal(proposal.primaryStep?.title, 'حضّر لامتحان رياضيات');
      // It opens the exam (and its «حضّرني») — and cannot rename it. «خلصتها»
      // is offered and marks the preparation done, never the exam
      // (tests/mobile/nextStepPrepDecisions.test.ts).
      assert.equal(proposal.primaryStep?.commitmentId, exam.id);
      assert.ok(!proposal.availableActions.includes('edit'), 'editing would rename the exam');
      assert.deepEqual([...proposal.availableActions].sort(), ['accept', 'defer', 'dismiss', 'done']);
      const prepares = proposal.explanation!.evidenceCodes.find((entry) => entry.code === 'prepares_for_event');
      assert.equal(prepares?.params?.at, exam.timeSpec.dueAt);
      assert.throws(() => prepareLiveNextStepDecision(proposal, 'edit', liveContext(arm, AT_EXAM), 'x'), /not available/);
    });
  });

  test(`#2 (${arm}): at 12:22 the night out is not the next step, and the step asks about it before the exam`, async () => {
    await withMemoryStorage(async () => {
      await capture(EXAM, AT_EXAM);
      await capture(NIGHT_OUT, AT_NIGHT_OUT);
      const state = await getParticipantStateSnapshot(UID);
      const exam = byTitle(state, 'امتحان');
      const night = byTitle(state, 'سهرة');
      const proposal = await getLiveNextStep(state, liveContext(arm, AT_NIGHT_OUT));
      assert.notEqual(proposal.primaryStep?.commitmentId, night.id, 'the night out was «خطوتك التالية» nine hours early');
      assert.equal(proposal.primaryStep?.commitmentId, exam.id);
      assert.equal(proposal.primaryStep?.purpose, 'prepare');
      const evening = proposal.explanation!.evidenceCodes.find((entry) => entry.code === 'evening_plan_before_event');
      assert.ok(evening, `no link to the night out: ${codesOf(proposal).join(', ')}`);
      assert.deepEqual([evening.params?.title, evening.params?.at], [night.title, night.timeSpec.dueAt]);
    });
  });

  test(`#2 (${arm}): earlier that morning, when the exam is 25 hours away, the night out still does not take the card`, async () => {
    // The production card ranked the night out «لازم خلال يوم» over an exam
    // «لازم هالأسبوع»: by the urgency bands alone, anything inside 24 hours
    // outranks an exam just beyond them.
    await withMemoryStorage(async () => {
      const morning = new Date('2026-10-03T06:00:00.000Z'); // 09:00
      await capture(EXAM, morning);
      await capture(NIGHT_OUT, morning);
      const state = await getParticipantStateSnapshot(UID);
      const proposal = await getLiveNextStep(state, liveContext(arm, morning));
      assert.notEqual(proposal.primaryStep?.commitmentId, byTitle(state, 'سهرة').id);
      assert.equal(proposal.primaryStep?.purpose, 'prepare');
      assert.ok(codesOf(proposal).includes('evening_plan_before_event'));
    });
  });

  test(`#2 (${arm}): a night out alone is no step at 12:22, and is "coming up" at 20:15`, async () => {
    await withMemoryStorage(async () => {
      await capture(NIGHT_OUT, AT_NIGHT_OUT);
      const state = await getParticipantStateSnapshot(UID);
      const night = byTitle(state, 'سهرة');
      const early = await getLiveNextStep(state, liveContext(arm, AT_NIGHT_OUT));
      assert.equal(early.primaryStep, null, `offered ${early.primaryStep?.title} at 12:22`);
      const soon = await getLiveNextStep(state, liveContext(arm, new Date('2026-10-03T17:15:00.000Z')));
      assert.equal(soon.primaryStep?.commitmentId, night.id);
      assert.equal(codesOf(soon)[0], 'starts_soon');
      assert.equal(soon.primaryStep?.purpose, undefined);
    });
  });

  test(`#2 (${arm}): with a study step already on the list, the study step is next — not the exam, and no second preparation`, async () => {
    await withMemoryStorage(async () => {
      await capture(EXAM, AT_EXAM);
      await capture('لازم أدرس رياضيات اليوم قبل الساعة 8 المسا', AT_EXAM);
      const state = await getParticipantStateSnapshot(UID);
      const study = byTitle(state, 'أدرس');
      const proposal = await getLiveNextStep(state, liveContext(arm, AT_EXAM));
      assert.equal(proposal.primaryStep?.commitmentId, study.id, `the step was ${proposal.primaryStep?.title}`);
      assert.equal(proposal.primaryStep?.purpose, undefined);
    });
  });

  test(`#2 (${arm}): a study session booked for 17:00 is the preparation, and it — a task with an hour — is the step`, async () => {
    // «أدرس الساعة 5» is a `scheduled_event` like the exam, but it is work to
    // do, not an event: it stays a candidate, as «أحضّر الغداء الساعة 2»
    // always has (N18). It also counts as the exam's preparation.
    await withMemoryStorage(async () => {
      await capture(EXAM, AT_EXAM);
      await capture('لازم أدرس رياضيات اليوم الساعة 5 المسا', AT_EXAM);
      const state = await getParticipantStateSnapshot(UID);
      const proposal = await getLiveNextStep(state, liveContext(arm, AT_EXAM));
      assert.equal(proposal.primaryStep?.commitmentId, byTitle(state, 'أدرس').id, `the step was ${proposal.primaryStep?.title}`);
      assert.equal(proposal.primaryStep?.purpose, undefined);
    });
  });

  test(`#2 (${arm}): inside its last hour the exam itself is the step, said as coming up`, async () => {
    await withMemoryStorage(async () => {
      await capture(EXAM, AT_EXAM);
      const state = await getParticipantStateSnapshot(UID);
      const proposal = await getLiveNextStep(state, liveContext(arm, new Date('2026-10-04T06:20:00.000Z'))); // 09:20
      assert.equal(proposal.primaryStep?.commitmentId, byTitle(state, 'امتحان').id);
      assert.equal(proposal.primaryStep?.purpose, undefined);
      assert.equal(codesOf(proposal)[0], 'starts_soon');
    });
  });
}

test('#2: an event is told from a task given an hour', () => {
  for (const title of ['عندي امتحان رياضيات', 'سهرة مع الصحاب', 'تطلع مع أصحابك', 'موعد دكتور', 'Birthday party', 'יש לי מבחן', 'מסיבה אצל דנה']) {
    assert.equal(namesEvent(title), true, title);
  }
  for (const title of ['أحضّر الغداء', 'أدرس رياضيات', 'send the report', 'call mum', 'حضّر العشا', 'لازم أطلع الزبالة']) {
    assert.equal(namesEvent(title), false, title);
  }
});

test('#2: the preparation title reads as spoken Arabic, Hebrew and English', () => {
  assert.equal(preparationTitle('عندي امتحان رياضيات', 'ar'), 'حضّر لامتحان رياضيات');
  assert.equal(preparationTitle('الامتحان النهائي', 'ar'), 'حضّر للامتحان النهائي');
  assert.equal(preparationTitle('React interview', 'ar'), 'حضّر لـReact interview');
  assert.equal(preparationTitle('I have an exam', 'en'), 'Prepare for exam');
  assert.equal(preparationTitle('Math exam', 'en'), 'Prepare for Math exam');
  assert.equal(preparationTitle('יש לי מבחן במתמטיקה', 'he'), 'להתכונן למבחן במתמטיקה');
  assert.equal(preparationTitle('הראיון', 'he'), 'להתכונן לראיון');
});

/* ── Review of the fix: tasks are not held back, preparation is not an exam ── */

/** 09:00 in Jerusalem on the audit's Saturday. */
const MORNING = new Date('2026-10-03T06:00:00.000Z');

/**
 * Timed tasks a reviewer found held back as "events" until their last hour:
 * a possessive, an appointment noun somewhere in the title, or a verb-led
 * errand about an event. Every one is work to do and stays a candidate.
 */
const TIMED_TASKS: Array<[string, string]> = [
  ['عندي تقرير لازم أسلمه اليوم الساعة 3 العصر', 'ar'],
  ['عندي شغل لازم أخلصه الساعة 2 الظهر', 'ar'],
  ['יש לי לשלוח את הדוח היום בשעה 15', 'he'],
  ['Call the dentist today at 3pm to reschedule', 'en'],
  ['Send the meeting notes today at 3pm', 'en'],
  ['اعمل تحليل البيانات الساعة 3 العصر', 'ar'],
  ['احكي مع الدكتور الساعة 3 العصر', 'ar'],
  ['Buy a birthday cake at 5pm', 'en'],
  ['احجز تذاكر الرحلة الساعة 4 العصر', 'ar'],
  ['Book the wedding venue at 4pm', 'en'],
  ['لازم أدرس للامتحان اليوم الساعة 5 المسا', 'ar'],
  ['Prepare for the interview today at 4pm', 'en'],
  ['Finish the presentation slides at 4pm', 'en'],
];

for (const [text, locale] of TIMED_TASKS) {
  test(`review #1/#2: «${text}» is a task — at 09:00 it is the next step itself, unchanged`, async () => {
    await withMemoryStorage(async () => {
      await capture(text, MORNING);
      const state = await getParticipantStateSnapshot(UID);
      const [only] = Object.values(state.commitments);
      assert.ok(only);
      assert.equal(namesEvent(only.title), false, `«${only.title}» read as an event`);
      const proposal = await getLiveNextStep(state, { ...(liveContext('generic', MORNING) as object), locale } as never);
      assert.equal(proposal.primaryStep?.commitmentId, only.id, `held back: ${JSON.stringify(proposal.primaryStep)}`);
      assert.equal(proposal.primaryStep?.purpose, undefined, `made into its own preparation: ${proposal.primaryStep?.title}`);
      assert.equal(proposal.primaryStep?.title, only.title);
    });
  });
}

test('review #1: events are still told apart from tasks by the noun that heads them', () => {
  for (const title of ['امتحان رياضيات', 'عندي امتحان رياضيات', 'سهرة مع الصحاب', 'عندي سهرة مع الصحاب', 'تطلع مع أصحابك', 'موعد دكتور', 'Math exam', 'Job interview', 'Birthday party', 'יש לי מבחן במתמטיקה', 'יש לי מסיבה', 'מסיבה אצל דנה']) {
    assert.equal(namesEvent(title), true, title);
  }
  for (const title of ['عندي تقرير لازم أسلمه', 'عندي شغل لازم أخلصه', 'יש לי לשלוח את הדוח', 'Call the dentist to reschedule', 'Send the meeting notes', 'اعمل تحليل البيانات', 'احكي مع الدكتور', 'Buy a birthday cake', 'احجز تذاكر الرحلة', 'Book the wedding venue', 'أدرس للامتحان', 'Prepare for the interview', 'Finish the presentation slides']) {
    assert.equal(namesEvent(title), false, title);
  }
});

test('review #2: a study session for the exam counts as its preparation — the session is next, no second preparation', async () => {
  await withMemoryStorage(async () => {
    await capture(EXAM, AT_EXAM);
    await capture('لازم أدرس للامتحان اليوم الساعة 5 المسا', AT_EXAM);
    const state = await getParticipantStateSnapshot(UID);
    const proposal = await getLiveNextStep(state, liveContext('generic', AT_EXAM));
    assert.equal(proposal.primaryStep?.commitmentId, byTitle(state, 'أدرس').id, `the step was ${proposal.primaryStep?.title}`);
    assert.equal(proposal.primaryStep?.purpose, undefined);
  });
});

test('review #4: the evening question names the plan once, without «عندي» / «יש לי»', async () => {
  await withMemoryStorage(async () => {
    await capture(EXAM, MORNING);
    await capture('عندي سهرة مع الصحاب الليلة الساعة 9', MORNING);
    const proposal = await getLiveNextStep(await getParticipantStateSnapshot(UID), liveContext('generic', MORNING));
    const evening = proposal.explanation!.evidenceCodes.find((entry) => entry.code === 'evening_plan_before_event');
    assert.equal(evening?.params?.title, 'سهرة مع الصحاب');
  });
  await withMemoryStorage(async () => {
    await capture('יש לי מבחן במתמטיקה מחר בשעה 10', MORNING);
    await capture('יש לי מסיבה הערב בשעה 21', MORNING);
    const proposal = await getLiveNextStep(await getParticipantStateSnapshot(UID), { ...(liveContext('generic', MORNING) as object), locale: 'he' } as never);
    assert.equal(proposal.primaryStep?.title, 'להתכונן למבחן במתמטיקה');
    const evening = proposal.explanation!.evidenceCodes.find((entry) => entry.code === 'evening_plan_before_event');
    assert.equal(evening?.params?.title, 'מסיבה');
  });
});

test('review #9: a bill due this afternoon comes before preparing for tomorrow\'s exam', async () => {
  await withMemoryStorage(async () => {
    await capture(EXAM, MORNING);
    await capture('لازم أدفع فاتورة الكهربا اليوم قبل الساعة 5 المسا', MORNING);
    const state = await getParticipantStateSnapshot(UID);
    const bill = byTitle(state, 'فاتورة');
    assert.equal(bill.timeSpec.kind, 'due_by');
    const proposal = await getLiveNextStep(state, liveContext('generic', MORNING));
    assert.equal(proposal.primaryStep?.commitmentId, bill.id, `the step was ${proposal.primaryStep?.title}`);
    // Once the bill is due later than the exam, preparing comes first again.
    const evening = await getLiveNextStep(state, liveContext('generic', new Date('2026-10-03T14:30:00.000Z')));
    assert.equal(evening.primaryStep?.purpose, 'prepare');
  });
});

/* ── Second review: the titles the capture model writes ──────────────── */

/**
 * In production the model titles a commitment as an instruction to the
 * person: «تطلع مع أصحابك» (the audit's own), «تحضر عرس ابن عمك», «تقدّم
 * امتحان الرياضيات». Read as verb-led tasks, an exam titled that way lost its
 * preparation step and a wedding came back as «بلّش فيها» hours early. The
 * verb of going to an event is set aside like «عندي»; what follows must still
 * be an event, so «قدّم الطلب» or "Take the trash out" stay tasks.
 */
const ATTENDED_EVENTS = [
  'تطلع مع أصحابك', 'تحضر عرس ابن عمك', 'تروح على عرس ابن عمك', 'تروح عالحفلة', 'تحضر حفلة عيد ميلاد',
  'تقدّم امتحان الرياضيات', 'قدم امتحان رياضيات', 'احضر حفلة عيد الميلاد', 'روح على المقابلة', 'تروح على مقابلة الشغل',
  'Take the math exam', 'Go to the party', 'Attend Sara\'s birthday party',
  'לעשות מבחן במתמטיקה', 'להגיע לחתונה', 'ללכת לחתונה של דני', 'ללכת למסיבה',
];
const STILL_TASKS = [
  'أحضّر الغداء', 'أحضّر للامتحان', 'حضّر للامتحان', 'احضر للمقابلة', 'قدّم الطلب', 'Take the trash out', 'לעשות כביסה',
  // The head is the first word in Arabic and Hebrew: a report or a summary *about* an exam is work.
  'تقرير عن امتحان الرياضيات', 'ملخص المقابلة', 'סיכום של המבחן',
];

test('second review: going to an event is still the event; preparing for one is a task', () => {
  for (const title of ATTENDED_EVENTS) assert.equal(namesEvent(title), true, title);
  for (const title of STILL_TASKS) assert.equal(namesEvent(title), false, title);
  assert.equal(preparationTitle('تقدّم امتحان الرياضيات', 'ar'), 'حضّر لامتحان الرياضيات');
  assert.equal(preparationTitle('Take the math exam', 'en'), 'Prepare for math exam');
});

/** A confirmed commitment as the model would have titled it, at an hour. */
function modelTitled(state: DomainState, id: string, title: string, dueAt: string, at: Date): DomainState {
  const now = at.toISOString();
  const created = applyCommand(state, {
    type: 'CreateDraft', now, draftStatus: 'pending_confirmation',
    commitment: { id, kind: 'task', title, timeSpec: { kind: 'scheduled_event', dueAt, remindAt: dueAt, timezone: TZ } },
  } as never).newState;
  return applyCommand(created, { type: 'ConfirmCommitment', commitmentId: id, now, reminders: [] } as never).newState;
}

for (const arm of NEXT_STEP_ARMS) {
  test(`second review (${arm}): «تقدّم امتحان الرياضيات» tomorrow gets its preparation, and «تحضر عرس ابن عمك» tonight is asked about, not started`, async () => {
    let state = createEmptyDomainState();
    state = modelTitled(state, 'exam', 'تقدّم امتحان الرياضيات', '2026-10-04T07:00:00.000Z', AT_EXAM);
    state = modelTitled(state, 'wedding', 'تحضر عرس ابن عمك', '2026-10-03T18:00:00.000Z', AT_NIGHT_OUT);
    const proposal = await getLiveNextStep(state, liveContext(arm, AT_NIGHT_OUT));
    assert.equal(proposal.primaryStep?.commitmentId, 'exam', `the step was ${JSON.stringify(proposal.primaryStep)}`);
    assert.equal(proposal.primaryStep?.purpose, 'prepare');
    assert.equal(proposal.primaryStep?.title, 'حضّر لامتحان الرياضيات');
    const evening = proposal.explanation!.evidenceCodes.find((entry) => entry.code === 'evening_plan_before_event');
    assert.equal(evening?.params?.title, 'عرس ابن عمك');
  });
}
