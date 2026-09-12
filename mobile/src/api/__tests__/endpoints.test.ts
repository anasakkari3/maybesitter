import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { resetAuthForTests, setAuthRepository } from '../auth';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { confirmCapture, proposeCapture } from '../endpoints/capture';
import { actOnCommitment, deleteCommitment, getCommitment, listToday, listUpcoming, patchCommitment } from '../endpoints/commitments';
import { getNextStep, recordNextStepDecision } from '../endpoints/nextStep';
import { getTrust, updateTrust } from '../endpoints/trust';
import { flagAlphaFeedback, getFeedbackHistory, revokeFeedback } from '../endpoints/feedback';
import { recordAnalyticsEvent } from '../endpoints/analytics';
import { buildTimePatch } from '../../features/commitments/timePatch';
import { nextStepResponseSchema } from '../schemas/nextStep';

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
