import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { setRecommendationConsent } from '../../lib/consents/recommendationConsentService.ts';
import { RECOMMENDATION_CONSENT_VERSION } from '../../src/contracts/v1/consentContracts.ts';
import {
  getMobileNextStep,
  MobilePilotError,
  recordMobileNextStepDecision,
} from '../../lib/services/mobile/pilotService.ts';
import { confirmMobileCapture, proposeMobileCapture } from '../../lib/services/mobile/mobileCaptureService.ts';
import { getCommitment, listUpcomingRanked } from '../../lib/services/mobile/commitmentService.ts';
import { listRecentNextStepDecisions } from '../../lib/services/mobile/nextStepDecisionLog.ts';

/**
 * What a decision on the next step actually does (UC-2.9, #170).
 *
 * Before this, every one of the five answers emitted an analytics event and
 * changed nothing: "Already done" left the commitment active, "Change it"
 * discarded the title, and "Later" brought the same item back on the next
 * fetch. The card asked five questions and acted on none of them.
 */

const UID = 'DecisionEffectsUser';

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

async function withCommitment(text: string): Promise<string> {
  await setRecommendationConsent(UID, { state: 'granted', version: RECOMMENDATION_CONSENT_VERSION });
  const proposal = await proposeMobileCapture(
    { text, timezone: 'UTC', referenceTime: new Date().toISOString() },
    { participantId: UID },
  );
  const confirmed = await confirmMobileCapture(
    {
      proposalId: proposal.proposalId,
      scopeId: UID,
      itemIds: proposal.items.map((item) => item.itemId),
      idempotencyKey: `k-${proposal.proposalId}`,
    },
    { participantId: UID },
  );
  const id = confirmed.persisted[0]?.commitmentId;
  assert.ok(id, 'expected a persisted commitment');
  return id;
}

async function proposalNow() {
  return (await getMobileNextStep(UID, { locale: 'en', timezone: 'UTC' })).recommendation;
}

async function decide(decision: string, extra: Record<string, unknown> = {}) {
  const proposal = await proposalNow();
  assert.equal(proposal.state, 'ready', 'expected a live proposal to decide on');
  return recordMobileNextStepDecision(UID, { locale: 'en', timezone: 'UTC', proposal, decision, ...extra });
}

test('done completes the commitment — the tap is the confirmation', async () => {
  const cleanup = setup();
  try {
    const id = await withCommitment('Remind me to send the report tomorrow at 3pm');
    assert.equal((await getCommitment(id, { participantId: UID }))?.status, 'active');
    await decide('done');
    assert.equal((await getCommitment(id, { participantId: UID }))?.status, 'completed');
  } finally {
    cleanup();
  }
});

test('edit rewrites the title the user changed', async () => {
  const cleanup = setup();
  try {
    const id = await withCommitment('Remind me to send the report tomorrow at 3pm');
    await decide('edit', { editedTitle: 'Send the short version of the report' });
    assert.equal((await getCommitment(id, { participantId: UID }))?.title, 'Send the short version of the report');
  } finally {
    cleanup();
  }
});

test('an edit outside 1-120 characters is refused, not trimmed to fit', async () => {
  const cleanup = setup();
  try {
    const id = await withCommitment('Remind me to send the report tomorrow at 3pm');
    const before = (await getCommitment(id, { participantId: UID }))?.title;
    for (const bad of ['', '   ', 'x'.repeat(121)]) {
      await assert.rejects(
        () => decide('edit', { editedTitle: bad }),
        (error: unknown) => error instanceof MobilePilotError && error.status === 400,
      );
    }
    // Silently shortening it would read as the product rewriting what they typed.
    assert.equal((await getCommitment(id, { participantId: UID }))?.title, before);
  } finally {
    cleanup();
  }
});

test('dismiss stops the next step offering it, and changes nothing else', async () => {
  const cleanup = setup();
  try {
    const id = await withCommitment('Remind me to send the report tomorrow at 3pm');
    await decide('dismiss');

    const after = await proposalNow();
    assert.notEqual(after.primaryStep?.commitmentId, id);

    // Still fully active and still in the account's lists — it is due
    // tomorrow, so Upcoming is where it belongs. "Not this one" is an answer
    // about the suggestion, not an edit to the commitment.
    const commitment = await getCommitment(id, { participantId: UID });
    assert.equal(commitment?.status, 'active');
    const upcoming = await listUpcomingRanked({ participantId: UID, timezone: 'UTC' });
    assert.ok(upcoming.items.some((item) => item.id === id), 'expected it to remain on Upcoming');
  } finally {
    cleanup();
  }
});

test('defer honours the time the client asked for', async () => {
  const cleanup = setup();
  try {
    await withCommitment('Remind me to send the report tomorrow at 3pm');
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await decide('defer', { deferUntil: until });
    const [record] = await listRecentNextStepDecisions(UID, new Date());
    assert.equal(record?.decision, 'defer');
    assert.equal(record?.deferUntil, until);
  } finally {
    cleanup();
  }
});

test('a defer in the past, or beyond the cap, falls back to the default day', async () => {
  const cleanup = setup();
  try {
    await withCommitment('Remind me to send the report tomorrow at 3pm');
    const before = Date.now();
    await decide('defer', { deferUntil: '1999-01-01T00:00:00.000Z' });
    const [record] = await listRecentNextStepDecisions(UID, new Date());
    const until = Date.parse(record!.deferUntil!);
    // Roughly a day out, not in 1999. A past instant would hide nothing at all.
    assert.ok(until > before, 'expected the fallback to be in the future');
    assert.ok(until <= before + 25 * 60 * 60 * 1000);
  } finally {
    cleanup();
  }
});

test('every decision is written to the user’s own history', async () => {
  const cleanup = setup();
  try {
    const id = await withCommitment('Remind me to send the report tomorrow at 3pm');
    await decide('accept');
    const [record] = await listRecentNextStepDecisions(UID, new Date());
    assert.equal(record?.decision, 'accept');
    assert.equal(record?.commitmentId, id);
    assert.ok(record?.proposalId);
    // The reason the card gave, kept with the answer, so the history can say
    // what the user was actually responding to.
    assert.ok(Array.isArray(record?.evidenceCodes));
  } finally {
    cleanup();
  }
});

test('the same decision replayed applies its effect once', async () => {
  const cleanup = setup();
  try {
    const id = await withCommitment('Remind me to send the report tomorrow at 3pm');
    const proposal = await proposalNow();
    const body = { locale: 'en', timezone: 'UTC', proposal, decision: 'done', idempotencyKey: 'once' };

    const first = await recordMobileNextStepDecision(UID, body);
    const second = await recordMobileNextStepDecision(UID, body);
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);

    assert.equal((await getCommitment(id, { participantId: UID }))?.status, 'completed');
    const history = await listRecentNextStepDecisions(UID, new Date());
    assert.equal(history.length, 1, 'a replay must not add a second row to the history');
  } finally {
    cleanup();
  }
});
