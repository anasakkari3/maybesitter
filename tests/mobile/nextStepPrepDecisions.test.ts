/**
 * Answering a preparation step answers the preparation, not the exam (review
 * of black-box audit 2026-10-03, #2).
 *
 * The preparation step points at the exam's commitment, and its decisions
 * were recorded under the exam's id: «مش هاي» on «حضّر لامتحان رياضيات» at
 * 12:13 hid the exam itself for a day, so its own «قرّب وقتها» step at 09:20
 * the next morning never came; and there was no way to say the preparation
 * was done. Decisions on it are now keyed `prepare:<exam>`, and `done` marks
 * the preparation done without completing the exam.
 *
 * Through the functions the routes call, on the audit's own sentence and clock.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { setRecommendationConsent } from '../../lib/consents/recommendationConsentService.ts';
import { RECOMMENDATION_CONSENT_VERSION } from '../../src/contracts/v1/consentContracts.ts';
import { getMobileNextStep, recordMobileNextStepDecision } from '../../lib/services/mobile/pilotService.ts';
import { confirmMobileCapture, proposeMobileCapture } from '../../lib/services/mobile/mobileCaptureService.ts';
import { getCommitment } from '../../lib/services/mobile/commitmentService.ts';
import { listRecentNextStepDecisions } from '../../lib/services/mobile/nextStepDecisionLog.ts';

const UID = 'PrepDecisionsUser';
const TZ = 'Asia/Jerusalem';
/** 12:13 on Saturday 3 October, when the audit saved the exam. */
const AT_EXAM = new Date('2026-10-03T09:13:00.000Z');
/** 09:20 on Sunday: forty minutes before the exam. */
const MORNING_OF = new Date('2026-10-04T06:20:00.000Z');

async function withAccount(run: (examId: string) => Promise<void>): Promise<void> {
  mock.timers.enable({ apis: ['Date'], now: AT_EXAM.getTime() });
  setStorageForTests(createMemoryStorage());
  const previous = {
    feature: process.env.MAYBESITTER_FEATURE_RECOMMENDATION,
    kill: process.env.MAYBESITTER_KILL_SWITCH_RECOMMENDATION,
  };
  process.env.MAYBESITTER_FEATURE_RECOMMENDATION = 'true';
  process.env.MAYBESITTER_KILL_SWITCH_RECOMMENDATION = 'false';
  try {
    await setRecommendationConsent(UID, { state: 'granted', version: RECOMMENDATION_CONSENT_VERSION });
    const proposal = await proposeMobileCapture({ text: 'عندي امتحان رياضيات بكرا الساعة 10', timezone: TZ, referenceTime: AT_EXAM.toISOString() }, { participantId: UID });
    const confirmed = await confirmMobileCapture({ proposalId: proposal.proposalId, itemIds: proposal.items.map((item) => item.itemId) }, { participantId: UID });
    const examId = confirmed.persisted[0]?.commitmentId;
    assert.ok(examId);
    await run(examId);
  } finally {
    resetStorageForTests();
    mock.timers.reset();
    for (const [key, value] of [['MAYBESITTER_FEATURE_RECOMMENDATION', previous.feature], ['MAYBESITTER_KILL_SWITCH_RECOMMENDATION', previous.kill]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const next = async () => (await getMobileNextStep(UID, { locale: 'ar', timezone: TZ })).recommendation;

async function decide(decision: string, extra: Record<string, unknown> = {}) {
  const proposal = await next();
  assert.equal(proposal.primaryStep?.purpose, 'prepare', `not the preparation: ${JSON.stringify(proposal.primaryStep)}`);
  return recordMobileNextStepDecision(UID, { locale: 'ar', timezone: TZ, proposal, decision, ...extra });
}

test('review #8: dismissing the preparation does not hide the exam — its own step comes the next morning', async () => {
  await withAccount(async (examId) => {
    await decide('dismiss');
    assert.equal((await next()).primaryStep, null, 'the preparation came straight back');
    mock.timers.setTime(MORNING_OF.getTime());
    const morning = await next();
    assert.equal(morning.primaryStep?.commitmentId, examId, 'the exam was hidden by a decision about its preparation');
    assert.equal(morning.primaryStep?.purpose, undefined);
    assert.equal(morning.explanation?.evidenceCodes[0]?.code, 'starts_soon');
  });
});

test('review #8: deferring the preparation keys the ledger by the preparation, not the exam', async () => {
  await withAccount(async (examId) => {
    await decide('defer', { deferUntil: new Date(AT_EXAM.getTime() + 3 * 3_600_000).toISOString() });
    const [record] = await listRecentNextStepDecisions(UID, new Date());
    assert.equal(record?.commitmentId, `prepare:${examId}`);
  });
});

test('review #7: «خلصتها» on the preparation marks it done, never the exam', async () => {
  await withAccount(async (examId) => {
    await decide('done');
    const exam = await getCommitment(examId, { participantId: UID });
    assert.equal(exam?.status, 'active', 'the exam was completed by finishing its preparation');
    assert.equal((await next()).primaryStep, null, 'a finished preparation came back');
    mock.timers.setTime(MORNING_OF.getTime());
    assert.equal((await next()).primaryStep?.commitmentId, examId);
  });
});
