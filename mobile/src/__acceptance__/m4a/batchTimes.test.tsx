import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { screen, waitFor } from '@testing-library/react-native';
import {
  PLAN,
  PLAN_ID,
  TIMES,
  TIMES_ID,
  defaultReply,
  lastRequest,
  openGoal,
  prepare,
  press,
  teardown,
  type M3aHarness,
} from '../m3a/harness';
import { NOW } from './harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

let harness: M3aHarness | undefined;

beforeEach(async () => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  harness = await prepare();
});

afterEach(async () => {
  await teardown(harness);
  harness = undefined;
  jest.useRealTimers();
});

async function openTimes(): Promise<void> {
  await openGoal(harness!);
  await screen.findByTestId('goal-plan-open');
  await press('goal-plan-open');
  await waitFor(() => expect(screen.queryByTestId('plan-approve')).not.toBeNull());
  await press('plan-approve');
  await waitFor(() => expect(screen.queryByTestId('plan-times-step-step-1')).not.toBeNull());
}

function batchTimes(unplaced: string[] = []) {
  return {
    success: true,
    times: {
      ...TIMES,
      timesRevision: TIMES.timesRevision + 1,
      steps: TIMES.steps.map((step) => step.stepId === 'step-4'
        ? { stepId: 'step-4', kind: 'commitment', slot: null, alternatives: [], choice: 'none' }
        : step),
    },
    unplaced,
  };
}

describe('M4a batch goal-plan times', () => {
  it('M4A-002 applies one exact CAS batch request and redraws the returned times', async () => {
    harness!.server.handler = (request) => request.path.endsWith('/times/batch')
      ? { status: 200, body: batchTimes() }
      : defaultReply(request);
    await openTimes();
    await press('plan-times-all');

    expect(screen.queryByTestId('plan-times-all-sheet')).not.toBeNull();
    await press('plan-times-all-part-evening');
    await press('plan-times-all-start-tomorrow');
    await press('plan-times-all-apply');

    await waitFor(() => expect(harness!.server.matching('POST', /\/times\/batch$/)).toHaveLength(1));
    expect(lastRequest(harness!.server, 'POST', /\/times\/batch$/).body).toEqual({
      timesId: TIMES_ID,
      timesRevision: TIMES.timesRevision,
      preference: { partOfDay: 'evening', startFrom: '2030-03-30' },
    });
  });

  it('M4A-R3-001 names every unplaced step and adopts choice none from the response', async () => {
    harness!.server.handler = (request) => request.path.endsWith('/times/batch')
      ? { status: 200, body: batchTimes(['step-4']) }
      : defaultReply(request);
    await openTimes();
    await press('plan-times-all');
    await press('plan-times-all-part-morning');
    await press('plan-times-all-apply');

    const notice = await screen.findByTestId('plan-times-unplaced');
    expect(notice).toHaveTextContent(PLAN.steps.find((step) => step.stepId === 'step-4')!.title, { exact: false });
    expect(screen.queryByTestId('plan-times-reason-step-4')).toBeNull();
  });

  it('M4A-R4-001 times_changed adopts the carried proposal before the next batch CAS', async () => {
    const current = { ...TIMES, timesRevision: 9 };
    let attempts = 0;
    harness!.server.handler = (request) => {
      if (!request.path.endsWith('/times/batch')) return defaultReply(request);
      attempts += 1;
      return attempts === 1
        ? { status: 409, body: { success: false, error: 'times_changed', reason: 'times_changed', times: current } }
        : { status: 200, body: { success: true, times: { ...current, timesRevision: 10 }, unplaced: [] } };
    };
    await openTimes();
    await press('plan-times-all');
    await press('plan-times-all-none');
    await press('plan-times-all-apply');
    await waitFor(() => expect(harness!.server.matching('POST', /\/times\/batch$/)).toHaveLength(1));

    await press('plan-times-all');
    await press('plan-times-all-none');
    await press('plan-times-all-apply');
    await waitFor(() => expect(harness!.server.matching('POST', /\/times\/batch$/)).toHaveLength(2));
    expect(lastRequest(harness!.server, 'POST', /\/times\/batch$/).body).toEqual({
      timesId: TIMES_ID,
      timesRevision: 9,
      preference: { noTime: true },
    });
  });

  it('M4A-R5-003 times_consumed leaves the times stage and refetches the plan', async () => {
    harness!.server.handler = (request) => request.path.endsWith('/times/batch')
      ? { status: 409, body: { success: false, error: 'times_consumed', reason: 'times_consumed' } }
      : defaultReply(request);
    await openTimes();
    const readsBefore = harness!.server.matching('GET', new RegExp(`/goals/.+/plan$`)).length;
    await press('plan-times-all');
    await press('plan-times-all-none');
    await press('plan-times-all-apply');

    await waitFor(() => expect(harness!.server.matching('GET', new RegExp(`/goals/.+/plan$`)).length).toBeGreaterThan(readsBefore));
    expect(screen.queryByTestId('plan-times-step-step-1')).toBeNull();
  });

  it('M4A-R7-004 picker offers today through day 14, never day 15', async () => {
    await openTimes();
    await press('plan-times-all');
    await press('plan-times-all-start-pick');

    expect(screen.queryByTestId('plan-times-all-day-2030-03-29')).not.toBeNull();
    expect(screen.queryByTestId('plan-times-all-day-2030-04-12')).not.toBeNull();
    expect(screen.queryByTestId('plan-times-all-day-2030-04-13')).toBeNull();
  });

  it('M4A-R7-004 the single-step change remains available after opening and closing the batch sheet', async () => {
    harness!.server.handler = (request) => request.path.endsWith('/times/batch')
      ? { status: 200, body: batchTimes() }
      : defaultReply(request);
    await openTimes();
    await press('plan-times-all');
    await press('plan-times-all-none');
    await press('plan-times-all-apply');
    await waitFor(() => expect(screen.queryByTestId('plan-times-change-step-1')).not.toBeNull());
    await press('plan-times-change-step-1');
    await press('plan-times-alt-step-1-1');
    await waitFor(() => expect(harness!.server.matching('PATCH', /\/times\/step-1$/)).toHaveLength(1));
  });

  it('M4A-R7-004 a server-side invalid date leaves the reviewed times unchanged', async () => {
    harness!.server.handler = (request) => request.path.endsWith('/times/batch')
      ? { status: 400, body: { success: false, error: 'invalid_preference', reason: 'invalid_preference' } }
      : defaultReply(request);
    await openTimes();
    await press('plan-times-all');
    await press('plan-times-all-start-tomorrow');
    await press('plan-times-all-apply');

    await screen.findByTestId('plan-failure');
    expect(screen.queryByTestId('plan-times-step-step-1')).not.toBeNull();
    expect(harness!.server.matching('POST', /\/times\/batch$/)).toHaveLength(1);
    expect(harness!.server.matching('POST', new RegExp(`/plans/${PLAN_ID}/confirm$`))).toHaveLength(0);
  });
});
