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
import type { Commitment, DomainState } from '../../src/domain/stateMachine.ts';

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
      // It opens the exam (and its «حضّرني») — and can neither complete nor rename it.
      assert.equal(proposal.primaryStep?.commitmentId, exam.id);
      assert.ok(!proposal.availableActions.includes('done'), '«خلصتها» would complete the exam');
      assert.ok(!proposal.availableActions.includes('edit'), 'editing would rename the exam');
      assert.ok(proposal.availableActions.includes('accept'));
      const prepares = proposal.explanation!.evidenceCodes.find((entry) => entry.code === 'prepares_for_event');
      assert.equal(prepares?.params?.at, exam.timeSpec.dueAt);
      assert.throws(() => prepareLiveNextStepDecision(proposal, 'done', liveContext(arm, AT_EXAM)), /not available/);
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
