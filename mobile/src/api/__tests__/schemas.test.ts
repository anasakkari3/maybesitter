import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { z } from 'zod';
import type { CalendarBusyUpload } from '../endpoints/calendar';
import { commitmentListSchema, commitmentSchema, errorBodySchema, importanceOf } from '../schemas/common';
import {
  commitmentActionResultSchema,
  commitmentDeleteResultSchema,
  invalidTransitionSchema,
  staleCommitmentSchema,
} from '../schemas/commitments';
import { captureConfirmationSchema, captureProposalSchema } from '../schemas/capture';
import { shareProposalSchema } from '../schemas/share';
import { nextStepDecisionResponseSchema, nextStepResponseSchema } from '../schemas/nextStep';
import { trustResponseSchema } from '../schemas/trust';
import { alphaFeedbackSchema, feedbackHistorySchema, feedbackRevokeSchema } from '../schemas/feedback';
import { activityPageSchema, weeklySummarySchema } from '../schemas/activity';
import { analyticsAckSchema } from '../schemas/analytics';
import {
  aiConsentUpdatedSchema,
  consentsViewSchema,
  personalizationConsentUpdatedSchema,
  recommendationConsentUpdatedSchema,
} from '../schemas/consents';
import {
  profileConfirmedSchema,
  profileProposalSchema,
  memoryCreatedSchema,
  memoryDeletedSchema,
  memoryListSchema,
  memorySuggestionDismissedSchema,
  memorySuggestionKeptSchema,
  profileResponseSchema,
  routineSavedSchema,
} from '../schemas/profile';
import {
  planEditRejectedSchema,
  planResponseSchema,
  planSettingsResponseSchema,
} from '../schemas/plan';
import {
  calendarBusyDeletedSchema,
  calendarBusyStoredSchema,
  calendarSettingsResponseSchema,
  deviceCalendarLinkConflictSchema,
  deviceCalendarLinkRemovedSchema,
  deviceCalendarLinkResponseSchema,
} from '../schemas/calendar';
import { reminderSettingsResponseSchema, hardReceiptsResponseSchema } from '../schemas/reminders';
import { readinessResponseSchema, readinessSavedSchema } from '../schemas/readiness';
import {
  financialConnectionSchema,
  financialContextResponseSchema,
  financialManualResponseSchema,
  financialManualSavedSchema,
} from '../schemas/financial';
import { deviceForgottenSchema, deviceRegisteredSchema } from '../schemas/devices';
import {
  icsDeadlineDecidedSchema,
  icsFeedCreatedSchema,
  icsFeedDeletedSchema,
  icsFeedListSchema,
  icsFeedRefreshedSchema,
  icsFeedRefusalSchema,
  icsFeedUpdatedSchema,
} from '../schemas/icsFeeds';

/**
 * The drift detector.
 *
 * Every fixture in `../__fixtures__/` was written by
 * `tests/mobile/exportMobileApiFixtures.test.ts`, which invokes the real route
 * handlers in-process. If the backend changes a response, that test rewrites
 * the fixture and this one fails — in CI, before a user's screen does.
 *
 * The last case is the one that makes the rest hold: every fixture must be
 * claimed by a schema. A new endpoint whose fixture nobody parses would
 * otherwise sit there looking like coverage.
 */

const FIXTURES = join(__dirname, '..', '__fixtures__');

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
}

const CASES: Array<[string, z.ZodType]> = [
  ['capture.proposal', captureProposalSchema],
  // Both are the same shape: the clarify endpoint answers with the whole
  // updated proposal, not an acknowledgement (#165).
  ['capture.needsClarification', captureProposalSchema],
  ['capture.clarified', captureProposalSchema],
  // The same schema again, over a proposal the model answered (#338). Without
  // it every recorded proposal says `rule-based` and the engine enum has
  // nothing to be wrong about.
  ['capture.geminiProposal', captureProposalSchema],
  // The share proposal is the capture proposal plus an envelope, and it is
  // parsed with its own schema rather than with `captureProposalSchema`, so
  // that a missing `share` block fails here instead of being ignored (#183).
  ['capture.shareProposal', shareProposalSchema],
  ['capture.confirmation', captureConfirmationSchema],
  ['capture.confirmationFailed', captureConfirmationSchema],
  ['commitments.today', commitmentListSchema],
  ['commitments.upcoming', commitmentListSchema],
  ['commitments.one', commitmentSchema],
  ['commitments.patched', commitmentSchema],
  ['commitments.action', commitmentActionResultSchema],
  ['commitments.deleted', commitmentDeleteResultSchema],
  ['commitments.notFound', errorBodySchema],
  ['commitments.stale', staleCommitmentSchema],
  ['commitments.invalidTransition', invalidTransitionSchema],
  ['consents.unanswered', consentsViewSchema],
  ['consents.answered', consentsViewSchema],
  ['consents.aiRecorded', aiConsentUpdatedSchema],
  ['consents.recommendationsRecorded', recommendationConsentUpdatedSchema],
  ['consents.unsupportedVersion', errorBodySchema],
  ['profile.empty', profileResponseSchema],
  ['profile.one', profileResponseSchema],
  ['profile.saved', routineSavedSchema],
  ['profile.described', profileProposalSchema],
  ['profile.describeConfirmed', profileConfirmedSchema],
  ['profile.describeExpired', errorBodySchema],
  ['memory.list', memoryListSchema],
  ['memory.created', memoryCreatedSchema],
  ['memory.patched', memoryCreatedSchema],
  ['memory.deleted', memoryDeletedSchema],
  ['memory.deletedAll', memoryDeletedSchema],
  ['memory.notFound', errorBodySchema],
  ['consents.personalizationRecorded', personalizationConsentUpdatedSchema],
  ['memory.withSuggestion', memoryListSchema],
  ['memory.suggestionKept', memorySuggestionKeptSchema],
  ['memory.suggestionDismissed', memorySuggestionDismissedSchema],
  ['memory.suggestionStale', errorBodySchema],
  ['memory.withDeferSuggestion', memoryListSchema],
  ['memory.deferSuggestionKept', memorySuggestionKeptSchema],
  ['nextStep.recommendation', nextStepResponseSchema],
  ['nextStep.decision', nextStepDecisionResponseSchema],
  ['trust.state', trustResponseSchema],
  ['trust.updated', trustResponseSchema],
  ['feedback.history', feedbackHistorySchema],
  ['feedback.revoked', feedbackRevokeSchema],
  ['alphaFeedback.flag', alphaFeedbackSchema],
  ['analytics.ack', analyticsAckSchema],
  ['consents.view', consentsViewSchema],
  // The daily plan (#194). GET, the accept/dismiss/edit action and regenerate
  // all answer the same `{ success, plan }` envelope, at three points in the
  // plan's life; the refusals differ, so they do not share a schema.
  ['plan.today', planResponseSchema],
  ['plan.accepted', planResponseSchema],
  ['plan.regenerated', planResponseSchema],
  // The one plan fixture that actually carries a protection (#522). Every
  // other one answers `protections: []`, so without this the five-field
  // protection schema is never parsed against anything a handler produced.
  ['plan.protected', planResponseSchema],
  ['plan.built', planResponseSchema],
  ['plan.notFound', errorBodySchema],
  ['plan.editRejected', planEditRejectedSchema],
  ['plan.settingsDefault', planSettingsResponseSchema],
  ['plan.settingsSaved', planSettingsResponseSchema],
  // The device calendar (UC-3.1, #185). `commitments.one` above is a commitment
  // with no link and `commitments.oneLinked` the same read once one exists, so
  // both halves of the nullable field are parsed from a real response.
  ['commitments.oneLinked', commitmentSchema],
  ['calendar.settingsDefault', calendarSettingsResponseSchema],
  ['calendar.settingsSaved', calendarSettingsResponseSchema],
  ['calendar.linkStored', deviceCalendarLinkResponseSchema],
  ['calendar.linkConflict', deviceCalendarLinkConflictSchema],
  ['calendar.linkRemoved', deviceCalendarLinkRemovedSchema],
  // Busy time (UC-3.2, #186). What is worth reading in these two fixtures is
  // what is *not* in them: a count and a window, and not one interval. The app
  // already knows what it sent, and an echo would be the only place in this
  // feature where busy times travelled back over the network.
  ['calendar.busyStored', calendarBusyStoredSchema],
  ['calendar.busyDeleted', calendarBusyDeletedSchema],
  ['errors.unauthorized', errorBodySchema],
  ['activity.list', activityPageSchema],
  ['activity.summary', weeklySummarySchema],
  // An accepted plan read back through the history: the plan ledger (#194)
  // merged into the activity route, with the day it was for and a live cursor.
  ['activity.planAccepted', activityPageSchema],
  // Gentle reminders (#196). The quiet hours on this response come from the
  // routine profile, which is the one place they are stored — so a change that
  // moved them somewhere else would rewrite this fixture and fail here.
  ['reminders.settingsDefault', reminderSettingsResponseSchema],
  ['reminders.settingsSaved', reminderSettingsResponseSchema],
  ['reminders.receiptsRecorded', hardReceiptsResponseSchema],
  // The financial context (#financial-v1). The context fixture is recorded
  // connected, corrected and overdrawn on purpose: an empty state is all
  // nulls, which every schema here accepts and none of them proves.
  ['financial.context', financialContextResponseSchema],
  ['financial.manual', financialManualResponseSchema],
  ['financial.manualSaved', financialManualSavedSchema],
  ['financial.connected', financialConnectionSchema],
  ['financial.connectionOff', financialConnectionSchema],
  ['readiness.current', readinessResponseSchema],
  ['readiness.saved', readinessSavedSchema],
  ['devices.registered', deviceRegisteredSchema],
  ['devices.forgotten', deviceForgottenSchema],
  // Subscribed calendar feeds (UC-3.4, #188). The schemas are strict: a
  // response that ever carried the feed URL, its host or a host hash would
  // fail here, in CI, before a phone could cache it.
  ['icsFeeds.created', icsFeedCreatedSchema],
  ['icsFeeds.list', icsFeedListSchema],
  ['icsFeeds.updated', icsFeedUpdatedSchema],
  ['icsFeeds.refreshed', icsFeedRefreshedSchema],
  ['icsFeeds.deadlineAccepted', icsDeadlineDecidedSchema],
  ['icsFeeds.deleted', icsFeedDeletedSchema],
  ['icsFeeds.invalidUrl', icsFeedRefusalSchema],
  ['icsFeeds.refreshTooSoon', icsFeedRefusalSchema],
];

/**
 * The upload body, checked against the route's own allowlist (UC-3.2, #186).
 *
 * The response fixtures above prove what comes back. This proves what goes:
 * `parseBusyUpload` on the server refuses a block with a fifth key, so the
 * client's type having exactly four is not a style choice, it is the request
 * succeeding. Asserted as a key set rather than as "no title", because a test
 * for the field somebody remembered passes for the one they did not.
 */
describe('what the busy upload is allowed to carry', () => {
  it('has four keys per block, and five on the envelope', () => {
    const body: CalendarBusyUpload = {
      sourceId: 'device:w1',
      platform: 'ios',
      windowStart: '2026-08-09T00:00:00.000Z',
      windowEnd: '2026-09-06T00:00:00.000Z',
      blocks: [{ blockId: 'a'.repeat(64), startAt: '2026-08-10T07:00:00.000Z', endAt: '2026-08-10T09:00:00.000Z', allDay: false }],
    };
    expect(Object.keys(body).sort()).toEqual(['blocks', 'platform', 'sourceId', 'windowEnd', 'windowStart']);
    expect(Object.keys(body.blocks[0]!).sort()).toEqual(['allDay', 'blockId', 'endAt', 'startAt']);
  });
});

describe('every response the client parses', () => {
  it.each(CASES)('%s matches its schema', (name, schema) => {
    const result = schema.safeParse(fixture(name));
    expect(result.success ? [] : result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`)).toEqual([]);
  });

  it('has a schema for every fixture on disk', () => {
    const onDisk = readdirSync(FIXTURES)
      .filter(name => name.endsWith('.json'))
      .map(name => name.replace(/\.json$/, ''))
      .sort();
    expect(onDisk).toEqual(CASES.map(([name]) => name).sort());
  });
});

describe('a protected block, as the plan screen reads it (#522)', () => {
  it('carries the block the protect action names, and the bound it was given', () => {
    const plan = planResponseSchema.parse(fixture('plan.protected')).plan;
    expect(plan.protections).toHaveLength(1);
    const protection = plan.protections[0]!;
    expect(protection.ownership).toBe('protected_flexible');
    expect(protection.maxShiftMinutes).toBe(30);
    expect(protection.preferredInterval).not.toBeNull();

    // The row and the protection name the same block. This is what makes the
    // mutation reachable: a screen protects the row it is looking at, and
    // without `blockId` on the row it would have nothing to send.
    const row = plan.scheduled.find(item => item.itemId === protection.itemId);
    expect(row?.blockId).toBe(protection.blockId);
  });

  it('gives every ordinary row a blockId too, so a first protection can be made', () => {
    const plan = planResponseSchema.parse(fixture('plan.today')).plan;
    expect(plan.protections).toEqual([]);
    expect(plan.scheduled.length).toBeGreaterThan(0);
    for (const row of plan.scheduled) expect(typeof row.blockId).toBe('string');
  });
});

describe('what the schemas assert about the shape', () => {
  /**
   * Absent and null are different answers (UC-3.1, #185).
   *
   * `commitments.one` has no link and says `deviceCalendarLink: null` — the
   * server looked and there is none. A 409 conflict body carries a commitment
   * and *no* such key, because a refusal is not a source of sync state. Reading
   * the second as the first is how a refused write becomes a duplicate event,
   * so the fixtures are asserted to differ rather than both merely parsing.
   */
  it('tells "there is no link" from "this response did not say"', () => {
    const unlinked = commitmentSchema.parse(fixture('commitments.one'));
    expect(unlinked.deviceCalendarLink).toBeNull();

    const linked = commitmentSchema.parse(fixture('commitments.oneLinked'));
    expect(linked.deviceCalendarLink?.state).toBe('linked');
    expect(linked.deviceCalendarLink?.writerId).toBe('writer-phone');

    const refused = staleCommitmentSchema.parse(fixture('commitments.stale'));
    expect('deviceCalendarLink' in refused.current).toBe(false);
  });

  /**
   * The calendar mapper decides between an all-day entry, a range and a short
   * block by reading these two. A backend that stopped sending one must fail
   * here rather than have the mapper read the absence as "no end, not all-day"
   * and write a thirty-minute block over somebody's day off.
   */
  it('requires an end and an all-day flag on every time spec', () => {
    const commitment = fixture('commitments.one') as { timeSpec: Record<string, unknown> };
    expect(commitment.timeSpec.endAt).toBeNull();
    expect(commitment.timeSpec.allDay).toBe(false);

    for (const field of ['endAt', 'allDay']) {
      const { [field]: _removed, ...rest } = commitment.timeSpec;
      const without = { ...commitment, timeSpec: rest };
      expect(`${field}:${commitmentSchema.safeParse(without).success}`).toBe(`${field}:false`);
    }
  });

  it('reads a confirmation failure from the body as well as the status', () => {
    const failed = captureConfirmationSchema.parse(fixture('capture.confirmationFailed'));
    // Before #252 this exact body came back with HTTP 200 and `success` was
    // the only signal — and the client did not read it. Both are checked now.
    expect(failed.success).toBe(false);
    expect(failed.failureCode).toBe('proposal_not_found');
    expect(failed.persisted).toEqual([]);
    expect(failed.failed[0]?.reason).toBe('proposal_not_found');
  });

  it('refuses an extraction engine the contract does not declare', () => {
    // UC-2.0 (#160) asks the app to fail on an unknown engine. `executedEngine`
    // was `z.string()`, so a server that started answering `"gpt-5"` — or a typo
    // in a fallback path — parsed clean and rendered as if nothing was odd. The
    // contract declares exactly three (src/contracts/v1/captureContracts.ts:167).
    const proposal = fixture('capture.proposal') as { provenance?: { executedEngine?: string } };
    expect(proposal.provenance?.executedEngine).toBe('rule-based');

    for (const engine of ['gemini', 'ollama', 'rule-based']) {
      const ok = { ...proposal, provenance: { ...proposal.provenance, executedEngine: engine } };
      expect(() => captureProposalSchema.parse(ok)).not.toThrow();
    }

    for (const engine of ['gpt-5', 'Gemini', 'rulebased', '', 'rule_based']) {
      const bad = { ...proposal, provenance: { ...proposal.provenance, executedEngine: engine } };
      expect(() => captureProposalSchema.parse(bad)).toThrow();
    }
  });

  /**
   * The half the case above could not do (#338).
   *
   * Every value it checks is one the test wrote: it edits `executedEngine` by
   * hand and then asks the schema what it thinks. That catches a narrowed
   * enum, and nothing else — it passes exactly as well on a backend that has
   * never once answered `gemini`, and until now none of the recorded responses
   * had, because no model is configured in the fixture run. So `gemini` was a
   * member of the enum with no evidence behind it that any server emits it.
   *
   * `capture.geminiProposal` is recorded from the real capture route with the
   * `@google/genai` module stubbed and nothing else replaced, so this reads a
   * value the server produced rather than one the test wrote. It fails if the
   * recorded engine stops being `gemini`, if the recording falls back to the
   * rules, or if the schema stops accepting the model's own name.
   */
  it('has recorded a proposal the model actually answered', () => {
    const recorded = captureProposalSchema.parse(fixture('capture.geminiProposal'));
    expect(recorded.provenance?.requestedEngine).toBe('model');
    expect(recorded.provenance?.executedEngine).toBe('gemini');
    // A model that answered and then fell back is a different recording; this
    // one exists to be the un-fallen-back case.
    expect(recorded.provenance?.fallbackUsed).toBe(false);
    expect(recorded.status).toBe('proposed');
    expect(recorded.items).toHaveLength(1);

    // Between the fixtures, every engine the contract declares is now a value
    // some recorded response really carries — except `ollama`, which is a
    // model on a developer's laptop and has no server to record from.
    const engines = ['capture.proposal', 'capture.clarified', 'capture.geminiProposal']
      .map(name => (fixture(name) as { provenance?: { executedEngine?: string } }).provenance?.executedEngine);
    expect(new Set(engines)).toEqual(new Set(['rule-based', 'gemini']));
  });

  it('keeps the whole recommendation, because the decision endpoint echoes it', () => {
    const response = nextStepResponseSchema.parse(fixture('nextStep.recommendation'));
    // A client that kept only the id could not satisfy `proposalFrom` in
    // pilotService, which reads `input.proposal` as an object.
    expect(typeof response.recommendation).toBe('object');
    expect(response.recommendation.proposalId).toEqual(expect.any(String));
    expect(response.recommendation.state).toBe('ready');
  });

  it('carries the newer commitment in a stale-edit refusal', () => {
    const stale = staleCommitmentSchema.parse(fixture('commitments.stale'));
    // The point of the 409: the client can show what the other device did,
    // rather than only that its own edit was refused.
    expect(stale.current.id).toEqual(expect.any(String));
    expect(stale.current.status).toBe('completed');
  });

  it('does not describe the conflicts with errorBodySchema', () => {
    // These refusals carry `reason` and no `error`, unlike every other one.
    // A schema that claimed otherwise would fail on the wire, not in CI.
    expect(errorBodySchema.safeParse(fixture('commitments.stale')).success).toBe(false);
    expect(errorBodySchema.safeParse(fixture('commitments.invalidTransition')).success).toBe(false);
  });

  it('maps server priority levels onto the design three', () => {
    const commitment = commitmentSchema.parse(fixture('commitments.one'));
    expect(importanceOf(commitment)).toBe('should');
    expect(importanceOf({ ...commitment, priority: { ...commitment.priority, level: 'high' } })).toBe('must');
    expect(importanceOf({ ...commitment, priority: { ...commitment.priority, level: 'low' } })).toBe('nice');
  });

  it('keeps the item a refused plan edit was about', () => {
    // The 422 is rendered next to the item the user dragged, not as a
    // page-level error, so `itemId` is the load-bearing half. `errorBodySchema`
    // parses this body too and throws that half away.
    const rejected = planEditRejectedSchema.parse(fixture('plan.editRejected'));
    expect(rejected.reason).toBe('unknown_item');
    expect(rejected.itemId).toEqual(expect.any(String));
  });

  it('reads a placed item whose commitment has since gone', () => {
    // planDto joins titles from the commitments at read time and answers null
    // for one that was deleted after the plan was built. A schema that required
    // a string would fail only on that user's device.
    const today = fixture('plan.today') as { plan: { scheduled: unknown[] } };
    const orphaned = {
      ...today,
      plan: { ...today.plan, scheduled: [{ ...(today.plan.scheduled[0] as object), title: null }] },
    };
    expect(planResponseSchema.safeParse(orphaned).success).toBe(true);
  });

  it('refuses a response that lost a field', () => {
    const { items, ...withoutItems } = fixture('commitments.today') as { items: unknown };
    expect(commitmentListSchema.safeParse(withoutItems).success).toBe(false);
    expect(items).toBeDefined();
  });

  /**
   * The other half of the calendar contract (UC-3.1, #185).
   *
   * The sync *deletes* what appears in `calendarOrphans`, so absent has to stay
   * readable as "this response did not look" — which means Today's recorded
   * response must carry the key even when it is empty. A backend that stopped
   * computing the join would regenerate this fixture without it, and the
   * optional schema would go on parsing happily; this is what goes red instead.
   */
  it('has Today say it looked for events with no commitment left', () => {
    const today = fixture('commitments.today') as Record<string, unknown>;
    expect('calendarOrphans' in today).toBe(true);
    expect(commitmentListSchema.parse(today).calendarOrphans).toEqual([]);

    // Upcoming deliberately does not answer, so one deletion is never asked
    // for twice.
    expect('calendarOrphans' in (fixture('commitments.upcoming') as object)).toBe(false);
  });

  it('accepts a response that gained one, so an older client keeps working', () => {
    const extended = { ...(fixture('commitments.one') as object), somethingNew: true };
    expect(commitmentSchema.safeParse(extended).success).toBe(true);
  });
});

describe('the next-step states that are not a suggestion', () => {
  /**
   * `nextStepReviewService` returns `explanation: null` and `primaryStep: null`
   * for both `empty` and `insufficient_evidence`. The fixture only ever covers
   * `ready`, because the fixture user always has a commitment — so these two
   * shapes have no other test, and a schema that rejects them would fail only
   * on a real device belonging to a user with an empty day.
   */
  const base = {
    success: true,
    participantId: 'user-1',
    recommendation: {
      version: 'v1',
      proposalId: 'p-1',
      locale: 'en',
      primaryStep: null,
      explanation: null,
      availableActions: [],
      persistence: { occurred: false, confirmationRequired: true },
    },
  };

  it('parses an empty day', () => {
    const parsed = nextStepResponseSchema.parse({
      ...base, recommendation: { ...base.recommendation, state: 'empty' },
    });
    expect(parsed.recommendation.explanation).toBeNull();
  });

  it('parses a day with too little to go on', () => {
    expect(() => nextStepResponseSchema.parse({
      ...base, recommendation: { ...base.recommendation, state: 'insufficient_evidence' },
    })).not.toThrow();
  });
});

describe('the feed schemas refuse a URL', () => {
  it('fails a feed or a created response that carries url, host or hostHash', () => {
    const created = fixture('icsFeeds.created') as { feed: Record<string, unknown> };
    for (const key of ['url', 'host', 'hostHash', 'encryptedUrl']) {
      expect(icsFeedCreatedSchema.safeParse({ ...created, feed: { ...created.feed, [key]: 'x' } }).success).toBe(false);
      expect(icsFeedCreatedSchema.safeParse({ ...created, [key]: 'x' }).success).toBe(false);
    }
  });
});
