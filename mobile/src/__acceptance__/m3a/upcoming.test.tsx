import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { screen, waitFor, within } from '@testing-library/react-native';
import {
  GOAL_ID,
  PLAN_ID,
  defaultReply,
  prepare,
  press,
  renderRoot,
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

describe('M3A-012/-033/-048 later weeks', () => {
  it('M3A-033 Today upcoming: shows only the first account-wide upcoming item', async () => {
    harness.server.handler = (request) =>
      request.path.endsWith('/goals/plans/upcoming')
        ? {
            status: 200,
            body: {
              success: true,
              items: [
                {
                  goalId: GOAL_ID,
                  planId: PLAN_ID,
                  goalTitle: 'First upcoming goal',
                  weekIndex: 3,
                  weekStartsOn: '2030-01-21',
                  stepCount: 1,
                },
                {
                  goalId: 'goal-2',
                  planId: 'plan-2',
                  goalTitle: 'Second upcoming goal',
                  weekIndex: 4,
                  weekStartsOn: '2030-01-28',
                  stepCount: 2,
                },
              ],
            },
          }
        : defaultReply(request);
    await renderRoot(harness);

    await waitFor(() => expect(screen.queryByTestId('plan-upcoming-card')).not.toBeNull());
    const card = within(screen.getByTestId('plan-upcoming-card'));
    expect(card.getByText(/First upcoming goal/)).toBeTruthy();
    expect(screen.queryByText(/Second upcoming goal/)).toBeNull();
  });

  it('M3A-012 later-week card: opens that plan times flow for its pending steps', async () => {
    await renderRoot(harness);
    await waitFor(() => expect(screen.queryByTestId('plan-upcoming-card')).not.toBeNull());
    await press('plan-upcoming-card');

    await waitFor(() => expect(screen.queryByTestId('plan-times-step-step-3')).not.toBeNull());
    expect(screen.queryByTestId('plan-times-step-step-1')).toBeNull();
  });

  it('M3A-048 upcoming feature unavailable: hides the Today card', async () => {
    harness.server.handler = (request) =>
      request.path.endsWith('/goals/plans/upcoming')
        ? { status: 404, body: { reason: 'feature_unavailable' } }
        : defaultReply(request);
    await renderRoot(harness);

    await waitFor(() => expect(harness.server.matching('GET', /\/goals\/plans\/upcoming$/)).toHaveLength(1));
    expect(screen.queryByTestId('plan-upcoming-card')).toBeNull();
  });
});

it.todo(
  'A1/A2 accessibility: default-size RTL reading order, disclosure focus and edit-sheet focus return need simulator',
);
it.todo('A1/A2 accessibility: AX5 has no clipped phase, step, edit or recovery controls and needs simulator');
it.todo(
  'A3/A4 scheduling: loaded-account slots avoid commitments, weekly blocks and busy calendar rows and need simulator',
);
it.todo(
  'A4 projection: after confirm, Today and Plan show the accepted times with no clash and need simulator',
);
