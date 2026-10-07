import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { screen, waitFor, within } from '@testing-library/react-native';
import {
  PLAN_ID,
  RESULT,
  TIMES,
  TIMES_ID,
  defaultReply,
  lastRequest,
  openGoal,
  prepare,
  press,
  teardown,
  type M3aHarness,
} from './harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'UTC' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

let harness: M3aHarness;

beforeEach(async () => {
  harness = await prepare();
});
afterEach(async () => {
  await teardown(harness);
});

async function openTimes(): Promise<void> {
  await openGoal(harness);
  await screen.findByTestId('goal-plan-open');
  await press('goal-plan-open');
  await waitFor(() => expect(screen.queryByTestId('plan-approve')).not.toBeNull());
  await press('plan-approve');
  await waitFor(() => expect(screen.queryByTestId('plan-times-step-step-1')).not.toBeNull());
}

async function openConfirm(): Promise<void> {
  await openTimes();
  await press('plan-times-none-step-none');
  await waitFor(() => expect(harness.server.matching('PATCH', /\/times\/step-none$/)).toHaveLength(1));
  await press('plan-times-next');
  await waitFor(() => expect(screen.queryByTestId('plan-confirm')).not.toBeNull());
}

describe('M3a A3 real times', () => {
  it('A3 times: a commitment slot and habit weekly timing are visible', async () => {
    await openTimes();
    expect(screen.getByTestId('plan-times-step-step-1')).toBeTruthy();
    expect(screen.getByTestId('plan-times-slot-step-1')).toBeTruthy();
    expect(screen.getByTestId('plan-times-step-step-2')).toBeTruthy();
    expect(screen.getByTestId('plan-times-weekly-step-2')).toBeTruthy();
  });

  it('A3 alternatives: change time sends a CAS PATCH with timesId, timesRevision and the selected slot', async () => {
    await openTimes();
    await press('plan-times-change-step-1');
    await press('plan-times-alt-step-1-1');

    await waitFor(() => expect(harness.server.matching('PATCH', /\/times\/step-1$/)).toHaveLength(1));
    expect(lastRequest(harness.server, 'PATCH', /\/times\/step-1$/).body).toEqual({
      timesId: TIMES_ID,
      timesRevision: TIMES.timesRevision,
      choice: { slot: TIMES.steps[0].alternatives[0] },
    });
  });

  it('A3 no time: the control sends a CAS PATCH with an explicit none choice', async () => {
    await openTimes();
    await press('plan-times-none-step-1');

    await waitFor(() => expect(harness.server.matching('PATCH', /\/times\/step-1$/)).toHaveLength(1));
    expect(lastRequest(harness.server, 'PATCH', /\/times\/step-1$/).body).toEqual({
      timesId: TIMES_ID,
      timesRevision: TIMES.timesRevision,
      choice: { none: true },
    });
  });

  it('A3 later week: it has a week note, no slot and no time controls', async () => {
    await openTimes();
    const later = within(screen.getByTestId('plan-times-step-step-3'));
    expect(later.getByTestId('plan-times-later-step-3')).toBeTruthy();
    expect(later.queryByTestId('plan-times-change-step-3')).toBeNull();
    expect(later.queryByTestId('plan-times-none-step-3')).toBeNull();
    expect(later.queryByTestId('plan-times-slot-step-3')).toBeNull();
  });

  it('A3 no room: the typed scheduling reason is shown for its step', async () => {
    await openTimes();
    expect(screen.getByTestId('plan-times-reason-step-4')).toBeTruthy();
  });

  it.each<['schedule_changed' | 'slot_in_past', 409 | 422]>([
    ['schedule_changed', 409],
    ['slot_in_past', 422],
  ])('A3 %s: adopts returned times and offers its own recovery', async (reason, status) => {
    const current = {
      ...TIMES,
      timesRevision: 9,
      steps: TIMES.steps.map((step) =>
        step.stepId === 'step-1'
          ? {
              ...step,
              alternatives: [
                ...step.alternatives,
                { startsAt: '2030-01-08T13:00:00.000Z', endsAt: '2030-01-08T13:30:00.000Z' },
              ],
            }
          : step,
      ),
    };
    harness.server.handler = (request) =>
      /\/times\/step-1$/.test(request.path)
        ? { status, body: { success: false, error: reason, reason, times: current } }
        : defaultReply(request);
    await openTimes();
    await press('plan-times-none-step-1');

    await waitFor(() => expect(screen.queryByTestId('plan-failure')).not.toBeNull());
    expect(screen.getByTestId('plan-failure-action')).toBeTruthy();
    expect(screen.getByTestId('plan-times-alt-step-1-2')).toBeTruthy();
    expect(harness.server.matching('PATCH', /\/times\/step-1$/)).toHaveLength(1);
  });
});

describe('M3a A4 one confirm', () => {
  it('A4 preview: saved has slot, weekly and none; stayed has only later, removed and no_room', async () => {
    await openConfirm();

    const saved = within(screen.getByTestId('plan-will-save'));
    expect(saved.getByTestId('plan-will-save-step-1')).toBeTruthy();
    expect(saved.getByTestId('plan-will-save-step-2')).toBeTruthy();
    expect(saved.getByTestId('plan-will-save-step-none')).toBeTruthy();
    const stayed = within(screen.getByTestId('plan-will-stay'));
    expect(stayed.getByTestId('plan-will-stay-step-3')).toBeTruthy();
    expect(stayed.getByTestId('plan-will-stay-removed-1')).toBeTruthy();
    expect(stayed.getByTestId('plan-will-stay-step-4')).toBeTruthy();
    expect(stayed.queryByTestId('plan-will-stay-step-none')).toBeNull();
  });

  it('A4 confirm: sends exactly the reviewed plan/times revisions and never authors a times array', async () => {
    await openConfirm();
    await press('plan-confirm');

    await waitFor(() => expect(harness.server.matching('POST', /\/confirm$/)).toHaveLength(1));
    const request = lastRequest(harness.server, 'POST', /\/confirm$/);
    expect(request.path).toContain(`/plans/${PLAN_ID}/confirm`);
    expect(request.body).toEqual({
      planRevision: TIMES.planRevision,
      timesId: TIMES_ID,
      timesRevision: TIMES.timesRevision + 1,
      idempotencyKey: expect.any(String),
    });
    expect(request.body).not.toHaveProperty('times');
  });

  it('A4 result: renders the response saved and stayed lists', async () => {
    await openConfirm();
    await press('plan-confirm');

    await waitFor(() => expect(screen.queryByTestId('plan-result')).not.toBeNull());
    for (const item of RESULT.saved)
      expect(screen.getByTestId(`plan-result-saved-${item.stepId}`)).toBeTruthy();
    for (const item of RESULT.stayed)
      expect(screen.getByTestId(`plan-result-stayed-${item.stepId}`)).toBeTruthy();
  });

  it('A4 retry: a retried confirm reuses the same idempotencyKey', async () => {
    let confirms = 0;
    harness.server.handler = (request) => {
      if (request.path.endsWith('/confirm')) {
        confirms += 1;
        return confirms === 1
          ? {
              status: 503,
              body: {
                success: false,
                error: 'model_unavailable',
                reason: 'model_unavailable',
                recovery: 'retry',
              },
            }
          : { status: 200, body: { success: true, ...RESULT } };
      }
      return defaultReply(request);
    };
    await openConfirm();
    await press('plan-confirm');
    await waitFor(() => expect(screen.queryByTestId('plan-failure-action')).not.toBeNull());
    await press('plan-failure-action');
    await waitFor(() => expect(harness.server.matching('POST', /\/confirm$/)).toHaveLength(2));

    const [first, second] = harness.server.matching('POST', /\/confirm$/);
    expect((first!.body as { idempotencyKey: string }).idempotencyKey).toBe(
      (second!.body as { idempotencyKey: string }).idempotencyKey,
    );
  });

  it('A4 key_reused: 409 shows its own failure and action', async () => {
    harness.server.handler = (request) =>
      request.path.endsWith('/confirm')
        ? {
            status: 409,
            body: { success: false, error: 'key_reused', reason: 'key_reused' },
          }
        : defaultReply(request);
    await openConfirm();
    await press('plan-confirm');

    await waitFor(() => expect(screen.queryByTestId('plan-failure')).not.toBeNull());
    expect(screen.getByTestId('plan-failure-action')).toBeTruthy();
  });
});
