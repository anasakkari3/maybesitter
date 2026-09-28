import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { resetAuthForTests, setAuthRepository } from '../auth';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { confirmCapture, proposeCapture } from '../endpoints/capture';
import { actOnCommitment, deleteCommitment, getCommitment, listToday, listUpcoming, patchCommitment } from '../endpoints/commitments';
import { getNextStep, recordNextStepDecision } from '../endpoints/nextStep';
import { getTrust, reportPilotIncident, updateTrust } from '../endpoints/trust';
import { flagAlphaFeedback, getFeedbackHistory, revokeFeedback } from '../endpoints/feedback';
import { recordAnalyticsEvent } from '../endpoints/analytics';
import { getWeeklySummary, listActivity } from '../endpoints/activity';
import { getReadiness, putSubjectiveEnergy } from '../endpoints/readiness';
import { buildTimePatch } from '../../features/commitments/timePatch';
import { nextStepResponseSchema } from '../schemas/nextStep';
import { createReadinessWatcher, pauseWatcher } from '../endpoints/watchers';
import watcherResponse from '../__fixtures__/watchers.created.json';
import { createMemory, keepMemorySuggestion } from '../endpoints/profile';
import { createHabit } from '../endpoints/habits';

/**
 * Each endpoint, against the fixture its own route produced.
 *
 * This is not "does fetch work" — `client.test.ts` covers that. It is: does
 * each function send the request the route accepts, and does what the route
 * answered parse into the type the screens use.
 */

const FIXTURES = join(__dirname, '..', '__fixtures__');
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));

let requests: Array<{ url: string; method: string; body: unknown; headers?: Record<string, string> }> = [];

function serve(body: unknown, status = 200, responseHeaders: Record<string, string> = {}): void {
  (globalThis as { fetch: unknown }).fetch = jest.fn(async (url: string, init: RequestInit) => {
    requests.push({
      url,
      method: init.method as string,
      body: init.body === undefined ? undefined : JSON.parse(init.body as string),
      headers: init.headers as Record<string, string>,
    });
    return {
      status,
      text: async () => JSON.stringify(body),
      headers: { get: (name: string) => responseHeaders[name.toLowerCase()] ?? null },
    };
  }) as never;
}

beforeEach(() => {
  requests = [];
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:3000';
  setAuthRepository(createFakeAuthRepository({
    initialUser: { uid: 'u1', email: null, emailVerified: true, displayName: null, providerIds: ['password'] },
  }));
});

afterEach(() => {
  resetAuthForTests();
  jest.restoreAllMocks();
});

describe('capture', () => {
  it('proposes without persisting, and carries the timezone', async () => {
    serve(fixture('capture.proposal'));
    const proposal = await proposeCapture({ text: 'Call the dentist tomorrow at 3pm', timezone: 'Asia/Jerusalem' });
    expect(requests[0]!.url).toBe('http://localhost:3000/api/mobile/capture');
    expect(requests[0]!.body).toMatchObject({ text: 'Call the dentist tomorrow at 3pm', timezone: 'Asia/Jerusalem' });
    expect(proposal.status).toBe('proposed');
    expect(proposal.items[0]!.itemId).toEqual(expect.any(String));
  });

  it('confirms the selected items and reads the persisted commitment ids back', async () => {
    serve(fixture('capture.confirmation'));
    const result = await confirmCapture({ proposalId: 'p1', itemIds: ['i1'], idempotencyKey: 'k1' });
    expect(requests[0]!.body).toEqual({ proposalId: 'p1', itemIds: ['i1'], idempotencyKey: 'k1' });
    expect(result.success).toBe(true);
    expect(result.persisted[0]!.commitmentId).toEqual(expect.any(String));
  });

  it('surfaces a lost proposal as a 404, and makes exactly one attempt', async () => {
    serve(fixture('capture.confirmationFailed'), 404);
    // The defect this guards (#252): a confirm that persisted nothing used to
    // answer 200. A client that retried here would multiply the damage instead
    // of reporting it.
    await expect(confirmCapture({ proposalId: 'gone', itemIds: ['i1'] })).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });
});

describe('watchers', () => {
  it('accepts the created watcher only on the route’s 201 response', async () => {
    serve(watcherResponse, 201);
    const result = await createReadinessWatcher('notify');
    expect(result.watcher.watcherId).toBe(watcherResponse.watcher.watcherId);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.body).toMatchObject({
      source: { provider: 'maybesitter', signalKind: 'readiness', subjectRef: 'self' },
      effect: 'notify',
    });
  });

  it('reads the pause and the resume the route actually sends, unnamed watcher included', async () => {
    serve(fixture('watchers.paused'));
    const paused = await pauseWatcher(watcherResponse.watcher.watcherId, true);
    expect(paused.watcher.label).toBeNull();
    expect(paused.watcher.status).toBe('paused');
    serve(fixture('watchers.resumed'));
    const resumed = await pauseWatcher(watcherResponse.watcher.watcherId, false);
    expect(resumed.watcher.enabled).toBe(true);
  });
});

describe('memory', () => {
  it('accepts the manual fact only on the route’s 201 response', async () => {
    serve(fixture('memory.created'), 201);
    const result = await createMemory({ kind: 'fact', content: 'A test fact', language: 'en' });
    expect(result.success).toBe(true);
    expect(requests[0]?.body).toEqual({ kind: 'fact', content: 'A test fact', language: 'en' });
  });

  it('accepts a kept suggestion on the route’s 201 response', async () => {
    serve({ success: true, decision: 'keep', memory: (fixture('memory.created') as { memory: unknown }).memory }, 201);
    const result = await keepMemorySuggestion({ ruleId: 'R2_defer_default', fingerprint: 'fingerprint-1' }, 'en');
    expect(result.decision).toBe('keep');
    expect(requests[0]?.body).toEqual({ decision: 'keep', fingerprint: 'fingerprint-1', language: 'en' });
  });
});

describe('habits', () => {
  it('accepts the created habit and materialized occurrences on the route’s 201 response', async () => {
    const response = fixture('habit.created') as { habit: { habitId: string }; occurrences: unknown[] };
    serve(response, 201);
    const habit = await createHabit({
      title: 'Test reading habit', cadence: { kind: 'weekly_count', count: 3 }, durationMinutes: 30,
      preferredWindows: [], minimumOccurrences: 3, maximumOccurrences: 3,
      flexibility: 'flexible', recoveryPolicy: 'skip', source: 'user_created',
      confirmation: { confirmedByUserAt: new Date().toISOString(), sourceRef: null, acceptedSuggestedValues: true },
    }, 'Asia/Hebron');
    expect(habit.habitId).toBe(response.habit.habitId);
    expect(response.occurrences).toHaveLength(12);
    expect(requests[0]?.url).toContain('timezone=Asia%2FHebron');
  });
});

describe('pilot incident reporting', () => {
  it('sends only the chosen surface and category and accepts the route’s 201 response', async () => {
    serve(fixture('pilot.incident'), 201);
    const result = await reportPilotIncident({ surface: 'capture', category: 'reliability' });
    expect(result.status).toBe('open');
    expect(requests[0]?.body).toEqual({ surface: 'capture', category: 'reliability' });
  });
});

describe('commitments', () => {
  it('lists today and upcoming with the timezone the device is in', async () => {
    serve(fixture('commitments.today'));
    await listToday({ timezone: 'Asia/Jerusalem' });
    expect(requests[0]!.url).toContain('timezone=Asia%2FJerusalem');

    serve(fixture('commitments.upcoming'));
    await listUpcoming({ timezone: 'Asia/Jerusalem' });
    expect(requests[1]!.url).toContain('/api/mobile/commitments/upcoming');
  });

  it('escapes the id in the path', async () => {
    serve(fixture('commitments.one'));
    await getCommitment('id with/slash');
    expect(requests[0]!.url).toBe('http://localhost:3000/api/mobile/commitments/id%20with%2Fslash');
  });

  it('returns the ETag alongside the commitment, for a later conditional write', async () => {
    serve(fixture('commitments.one'), 200, { etag: '"2026-08-09T09:00:00.000Z.abc123def456"' });
    const result = await getCommitment('c1');
    // Echoed, never constructed: the validator is `updatedAt` plus a digest.
    expect(result.etag).toBe('"2026-08-09T09:00:00.000Z.abc123def456"');
    expect(result.data.id).toEqual(expect.any(String));
  });

  it('sends the validator as If-Match when one is given', async () => {
    serve(fixture('commitments.patched'));
    await patchCommitment('c1', { title: 'x' }, '"2026-08-09T09:00:00.000Z.abc123def456"');
    expect(requests[0]!.headers?.['If-Match']).toBe('"2026-08-09T09:00:00.000Z.abc123def456"');
  });

  it('sends no If-Match when none is given, so a first write stays unconditional', async () => {
    serve(fixture('commitments.patched'));
    await patchCommitment('c1', { title: 'x' });
    expect(requests[0]!.headers?.['If-Match']).toBeUndefined();
  });

  it('sends a plain time move as dueDate alone, never touching the reminder', async () => {
    serve(fixture('commitments.patched'));
    // The whole point of buildTimePatch (#208): the retired client sent
    // `reminderTime` on every edit, which collapsed a deliberately-set lead
    // onto the due time whenever the user dragged an item an hour later.
    const patch = buildTimePatch(
      { dueAt: '2026-08-10T12:00:00.000Z', remindAt: '2026-08-10T11:00:00.000Z' },
      '2026-08-10T14:00:00.000Z',
    );
    await patchCommitment('c1', patch);
    expect(requests[0]!.method).toBe('PATCH');
    expect(requests[0]!.body).toEqual({ dueDate: '2026-08-10T14:00:00.000Z' });
    expect(requests[0]!.body).not.toHaveProperty('reminderTime');
  });

  it('sends no time fields at all for a title-only edit', async () => {
    serve(fixture('commitments.patched'));
    const patch = buildTimePatch({ dueAt: '2026-08-10T12:00:00.000Z', remindAt: null }, undefined);
    await patchCommitment('c1', { ...patch, title: 'Call the dentist' });
    expect(requests[0]!.body).toEqual({ title: 'Call the dentist' });
  });

  it('moves a reminder-only item by its reminder', async () => {
    serve(fixture('commitments.patched'));
    await patchCommitment('c1', buildTimePatch({ dueAt: null, remindAt: '2026-08-10T11:00:00.000Z' }, '2026-08-10T14:00:00.000Z'));
    expect(requests[0]!.body).toEqual({ reminderTime: '2026-08-10T14:00:00.000Z' });
  });

  it('acts on a commitment and reads the updated one back', async () => {
    serve(fixture('commitments.action'));
    const result = await actOnCommitment('c1', 'complete');
    expect(requests[0]!.body).toEqual({ action: 'complete' });
    expect(result.data.commitment.status).toBe('completed');
  });

  it('reports a delete as the soft drop it actually is', async () => {
    serve(fixture('commitments.deleted'));
    const result = await deleteCommitment('c1');
    expect(requests[0]!.method).toBe('DELETE');
    expect(result).toMatchObject({ deleted: false, softDeleted: true, status: 'dropped' });
  });
});

describe('next step', () => {
  it('echoes the whole proposal back, not just its id', async () => {
    const response = nextStepResponseSchema.parse(fixture('nextStep.recommendation'));
    serve(fixture('nextStep.decision'));
    await recordNextStepDecision({
      locale: 'en',
      decision: 'accept',
      proposal: response.recommendation,
      idempotencyKey: 'k1',
    });
    const body = requests[0]!.body as { proposal: unknown; decision: string };
    // `proposalFrom` in pilotService reads `input.proposal` as an object and
    // compares it against the live proposal; an id alone is a 400.
    expect(typeof body.proposal).toBe('object');
    expect(body.proposal).toMatchObject({ proposalId: response.recommendation.proposalId, state: 'ready' });
    expect(body.decision).toBe('accept');
  });

  it('asks for the recommendation in the callers locale', async () => {
    serve(fixture('nextStep.recommendation'));
    await getNextStep('ar');
    expect(requests[0]!.url).toContain('locale=ar');
  });
});

describe('trust, feedback and analytics', () => {
  it('reads and updates trust through the same shape', async () => {
    serve(fixture('trust.state'));
    const state = await getTrust();
    expect(state.trust.recommendationConsent).toBe(false);

    serve(fixture('trust.updated'));
    await updateTrust({ type: 'set_analytics_consent', granted: true });
    expect(requests[1]!.body).toEqual({ action: { type: 'set_analytics_consent', granted: true } });
  });

  it('keeps revoked rows in history, because they are the proof of a correction', async () => {
    serve(fixture('feedback.history'));
    const history = await getFeedbackHistory();
    expect(history.rows[0]!.canRevoke).toBe(true);

    serve(fixture('feedback.revoked'));
    const revoked = await revokeFeedback(history.rows[0]!.id);
    expect(revoked.row.revokedAt).not.toBeNull();
    expect(revoked.row.canRevoke).toBe(false);
  });

  it('flags alpha feedback on the 201 the route answers with', async () => {
    serve(fixture('alphaFeedback.flag'), 201);
    const flag = await flagAlphaFeedback({ proposalId: 'p1', category: 'not_useful' });
    expect(flag.category).toBe('not_useful');
  });

  it('treats recorded:false as the consent choice it is, not a failure', async () => {
    serve({ ...(fixture('analytics.ack') as object), recorded: false, eventId: null });
    const ack = await recordAnalyticsEvent('reason_opened', { proposalId: 'p1' });
    expect(ack.success).toBe(true);
    expect(ack.recorded).toBe(false);
  });
});

describe('activity (#201)', () => {
  it('reads a page of history and does not send a cursor it does not have', async () => {
    serve(fixture('activity.list'));
    const page = await listActivity();
    expect(requests[0]!.url).toBe('http://localhost:3000/api/mobile/activity');
    expect(page.items[0]!.kind).toBe('completed');
    expect(page.nextCursor).toBeNull();
  });

  it('echoes the server’s cursor back and never builds one', async () => {
    // The one shape no fixture can carry: the mock adapter serves the same
    // body for every request, so a fixture with a cursor would make the
    // infinite scroll ask for the next page forever.
    serve({ items: [], nextCursor: '2026-09-14T09:00:00.000Z|abc' });
    const page = await listActivity({ cursor: '2026-09-13T09:00:00.000Z|xyz', limit: 10 });
    expect(requests[0]!.url).toContain('cursor=2026-09-13T09%3A00%3A00.000Z%7Cxyz');
    expect(requests[0]!.url).toContain('limit=10');
    expect(page.nextCursor).toBe('2026-09-14T09:00:00.000Z|abc');
  });

  it('lets the server decide which week it is unless a week is named', async () => {
    serve(fixture('activity.summary'));
    await getWeeklySummary();
    expect(requests[0]!.url).toBe('http://localhost:3000/api/mobile/activity/summary');

    serve(fixture('activity.summary'));
    await getWeeklySummary('2026-09-13');
    expect(requests[1]!.url).toContain('weekStart=2026-09-13');
  });

  it('reads the Moments the counter answered with, on a week with nothing in it', async () => {
    serve(fixture('activity.summary'));
    const summary = await getWeeklySummary('2026-08-09');
    expect(summary.completedCount).toBe(0);
    expect(summary.moments.length).toBeGreaterThan(0);
  });
});

describe('readiness', () => {
  it('reads the provider-independent readiness projection', async () => {
    serve(fixture('readiness.current'));
    const current = await getReadiness();
    expect(requests[0]!.url).toBe('http://localhost:3000/api/mobile/readiness');
    expect(current.selectedSource).toBe('current_subjective');
    expect(current.readiness?.sourceKinds).toEqual(['subjective']);
  });

  it('saves subjective energy without sending native health payloads', async () => {
    serve(fixture('readiness.saved'));
    await putSubjectiveEnergy({ energy: 4, observedAt: '2026-09-17T06:25:00.000Z' });
    expect(requests[0]).toMatchObject({
      url: 'http://localhost:3000/api/mobile/readiness',
      method: 'PUT',
      body: { energy: 4, observedAt: '2026-09-17T06:25:00.000Z' },
    });
  });
});
