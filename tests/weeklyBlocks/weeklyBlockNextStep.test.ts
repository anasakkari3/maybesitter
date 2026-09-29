/**
 * The next step does not suggest starting work while a weekly block is under
 * way («ثابت أسبوعي»): during Saturday's 10:00–16:00 shift the person is at
 * the shift. Same shape as quiet hours — 200, no card, and an `exposure` that
 * says why and until when («حتى 16:00») — because nothing is wrong.
 *
 * `getMobileNextStep` reads the real clock, so the block is built around this
 * moment in Jerusalem: every day, from an hour ago to an hour ahead.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { setRecommendationConsent } from '../../lib/consents/recommendationConsentService.ts';
import { RECOMMENDATION_CONSENT_VERSION } from '../../src/contracts/v1/consentContracts.ts';
import { getMobileNextStep } from '../../lib/services/mobile/pilotService.ts';
import { persistParticipantState } from '../../lib/services/mobile/participantState.ts';
import { applyCommand as applyDomainCommand, createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import { createWeeklyBlock, patchWeeklyBlock } from '../../lib/weeklyBlocks/weeklyBlockService.ts';

const UID = 'WeeklyBlockNextStepUser';
const ZONE = 'Asia/Jerusalem';

function setup() {
  setStorageForTests(createMemoryStorage());
  const previous = {
    MAYBESITTER_FEATURE_RECOMMENDATION: process.env.MAYBESITTER_FEATURE_RECOMMENDATION,
    MAYBESITTER_KILL_SWITCH_RECOMMENDATION: process.env.MAYBESITTER_KILL_SWITCH_RECOMMENDATION,
  };
  process.env.MAYBESITTER_FEATURE_RECOMMENDATION = 'true';
  process.env.MAYBESITTER_KILL_SWITCH_RECOMMENDATION = 'false';
  return () => {
    resetStorageForTests();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/** A same-day window around this minute in Jerusalem, or null in the day's last minute. */
function windowAroundNow(): { start: string; end: string } | null {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const now = Number(parts.find((p) => p.type === 'hour')!.value) * 60 + Number(parts.find((p) => p.type === 'minute')!.value);
  if (now >= 23 * 60 + 58) return null;
  const clock = (total: number) => `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  return { start: clock(Math.max(0, now - 60)), end: clock(Math.min(23 * 60 + 59, now + 60)) };
}

async function accountWithWork(): Promise<void> {
  await setRecommendationConsent(UID, { state: 'granted', version: RECOMMENDATION_CONSENT_VERSION });
  const at = new Date(Date.now() - 86_400_000).toISOString();
  let state = createEmptyDomainState();
  state = applyDomainCommand(state, {
    type: 'CreateDraft', now: at, draftStatus: 'pending_confirmation',
    commitment: { id: 'cmt_report', kind: 'task', title: 'Write the report', timeSpec: { kind: 'due_by', dueAt: new Date(Date.now() + 3 * 3_600_000).toISOString(), remindAt: null, timezone: ZONE } },
  }).newState;
  state = applyDomainCommand(state, { type: 'ConfirmCommitment', commitmentId: 'cmt_report', now: at, reminders: [] }).newState;
  await persistParticipantState(UID, state);
}

test('inside an active weekly block there is no card, and the exposure says until when', async (t) => {
  const window = windowAroundNow();
  if (!window) {
    t.skip('VISIBLE SKIP: the last two minutes of the Jerusalem day cannot hold a same-day block around now');
    return;
  }
  const cleanup = setup();
  try {
    await accountWithWork();
    // The control first: the same account, no block, gets its card.
    const before = await getMobileNextStep(UID, { locale: 'ar', timezone: ZONE });
    assert.equal(before.recommendation.state, 'ready', 'without the block there was no card; this proves nothing');

    const { block } = await createWeeklyBlock(UID, {
      title: 'دوام', weekdays: [0, 1, 2, 3, 4, 5, 6], start: window.start, end: window.end, timezone: ZONE,
      confirmedAt: new Date().toISOString(),
    });
    const during = await getMobileNextStep(UID, { locale: 'ar', timezone: ZONE });
    assert.equal(during.recommendation.state, 'empty');
    assert.equal(during.recommendation.primaryStep, null);
    assert.deepEqual(during.recommendation.availableActions, []);
    assert.deepEqual(during.exposure, { allowed: false, reason: 'weekly_block', until: window.end });

    // Paused, the block no longer holds the moment: the card comes back.
    await patchWeeklyBlock(UID, block.id, { status: 'paused' });
    const paused = await getMobileNextStep(UID, { locale: 'ar', timezone: ZONE });
    assert.equal(paused.recommendation.state, 'ready');
    assert.equal(paused.exposure.allowed, true);
  } finally {
    cleanup();
  }
});
