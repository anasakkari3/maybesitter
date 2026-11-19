/**
 * A daily habit on Today (QA v3 V3-F23-06, owner decision 2026-11-20): a
 * quiet row with «تمّت», marked through the habit occurrence route and taken
 * back through its undo (#868). A habit not due today is not drawn. The day
 * the rows are for is the server's `localDate`, so no device clock is read.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../api/auth';
import type { AuthUser } from '../../auth/types';
import { TodayScreen } from '../TodayScreen';
import en from '../../i18n/locales/en.json';
import { fill } from '../../i18n/strings';
import { isolateAuto } from '../../i18n/bidi';
import { ConflictError } from '../../api/errors';
import commitmentFixture from '../../api/__fixtures__/commitments.one.json';
import profileFixture from '../../api/__fixtures__/profile.one.json';
import consentsFixture from '../../api/__fixtures__/consents.answered.json';
import * as commitmentEndpoints from '../../api/endpoints/commitments';
import * as nextStepEndpoints from '../../api/endpoints/nextStep';
import * as consentEndpoints from '../../api/endpoints/consents';
import * as planEndpoints from '../../api/endpoints/plans';
import * as profileEndpoints from '../../api/endpoints/profile';
import * as weeklyEndpoints from '../../api/endpoints/weeklyBlocks';
import * as habitEndpoints from '../../api/endpoints/habits';
import type { Habit, HabitOccurrence, HabitToday } from '../../api/schemas/habits';

jest.mock('../../i18n/timezone', () => ({
  ...(jest.requireActual('../../i18n/timezone') as object),
  useTimeZone: () => 'Asia/Jerusalem',
}));

const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const USER: AuthUser = { uid: 'today-habits-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'] };
const DAY = '2026-11-20';

function habit(habitId: string, title: string, overrides: Partial<Habit> = {}): Habit {
  return {
    habitId, title, cadence: { kind: 'weekdays', weekdays: [0, 1, 2, 3, 4, 5, 6] }, durationMinutes: 30,
    preferredWindows: [], minimumOccurrences: 7, maximumOccurrences: 7, flexibility: 'protected_flexible', recoveryPolicy: 'skip',
    status: 'active', source: 'capture_chat',
    confirmation: { confirmedByUserAt: '2026-11-01T09:00:00.000Z', sourceRef: null, acceptedSuggestedValues: true },
    createdAt: '2026-11-01T09:00:00.000Z', updatedAt: '2026-11-01T09:00:00.000Z',
    ...overrides,
  };
}
const occurrence = (habitId: string, state: HabitOccurrence['state'] = 'pending'): HabitOccurrence => ({
  occurrenceId: `${habitId}.${DAY}.0`, habitId, localDate: DAY, ordinal: 0, state, durationMinutes: 30, recoveredFromOccurrenceId: null,
});

const WALK = habit('walk', 'Walk', { preferredWindows: [{ start: '07:00', end: '08:00' }] });
const READ = habit('read', 'Read');
const GYM = habit('gym', 'Gym', { cadence: { kind: 'weekly_count', count: 3 }, minimumOccurrences: 3, maximumOccurrences: 3 });
const PILATES = habit('pilates', 'Pilates', { cadence: { kind: 'weekdays', weekdays: [2] }, minimumOccurrences: 1, maximumOccurrences: 1 });

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;
let todayAnswer: HabitToday;

beforeEach(() => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(planEndpoints, 'getPlan').mockResolvedValue(null as never);
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
  jest.spyOn(profileEndpoints, 'getProfile').mockResolvedValue({ ...profileFixture, routine: { ...profileFixture.routine, timezone: 'Asia/Jerusalem' } } as never);
  jest.spyOn(consentEndpoints, 'getConsents').mockResolvedValue(consentsFixture as never);
  jest.spyOn(weeklyEndpoints, 'listWeeklyBlockOccurrences').mockResolvedValue([]);
  jest.spyOn(nextStepEndpoints, 'getNextStep').mockResolvedValue({
    success: true, participantId: USER.uid,
    recommendation: { version: 'v1', proposalId: 'e', state: 'empty', locale: 'en', primaryStep: null, explanation: null },
  } as never);
  // Gym is a weekly count with an off day offered today; Pilates is Tuesdays only (none today).
  todayAnswer = { localDate: DAY, occurrences: [occurrence('read'), occurrence('gym'), occurrence('walk')], anyDay: [`gym.${DAY}.0`], weeks: [{ habitId: 'gym', completed: 0, target: 3 }] };
  jest.spyOn(habitEndpoints, 'listHabits').mockResolvedValue([READ, GYM, PILATES, WALK]);
  jest.spyOn(habitEndpoints, 'listHabitsToday').mockImplementation(async () => todayAnswer);
});

afterEach(() => { client.clear(); resetAuthForTests(); jest.restoreAllMocks(); });

async function show() {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}><TodayScreen /></QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('query-loading')).toBeNull());
}

describe('habits on Today', () => {
  it('draws today\'s daily habits as quiet rows, in the order of their hours, and nothing not due today', async () => {
    await show();
    await waitFor(() => expect(screen.queryByTestId('today-habits')).not.toBeNull());
    const block = screen.getByTestId('today-habits');
    expect(within(block).getByText(en.todayHabitsTitle)).toBeTruthy();
    expect(screen.queryByTestId('today-habit-walk')).not.toBeNull();
    expect(screen.queryByTestId('today-habit-read')).not.toBeNull();
    // A weekly count's off day and a Tuesday-only habit are not due today.
    expect(screen.queryByTestId('today-habit-gym')).toBeNull();
    expect(screen.queryByTestId('today-habit-pilates')).toBeNull();
    // Walk prefers 07:00, Read has no hour: Walk first.
    const rows = within(block).getAllByTestId(/^today-habit-(walk|read)$/).map(node => node.props.testID);
    expect(rows).toEqual(['today-habit-walk', 'today-habit-read']);
    // «تمّت», named for the habit, 44 points to press.
    const done = screen.getByTestId('today-habit-done-walk');
    expect(done.props.accessibilityLabel).toBe(fill(en.xHabitTodayDoneA11y, { title: isolateAuto('Walk') }));
    expect(done.props.style).toEqual(expect.objectContaining({ minWidth: 44, minHeight: 44 }));
    // The day stays empty of commitments, and says so.
    expect(screen.queryByTestId('today-empty')).not.toBeNull();
  });

  it('marks today done through the occurrence route, and takes it back through undo', async () => {
    const decide = jest.spyOn(habitEndpoints, 'decideHabitOccurrence').mockImplementation(async decision => {
      todayAnswer = { ...todayAnswer, occurrences: todayAnswer.occurrences.map(row => row.occurrenceId === decision.occurrenceId ? { ...row, state: 'completed' } : row) };
      return { success: true, occurrence: { ...occurrence('walk'), state: 'completed' }, changed: true };
    });
    const undo = jest.spyOn(habitEndpoints, 'undoHabitOccurrence').mockImplementation(async ref => {
      todayAnswer = { ...todayAnswer, occurrences: todayAnswer.occurrences.map(row => row.occurrenceId === ref.occurrenceId ? { ...row, state: 'pending' } : row) };
      return { success: true, occurrence: occurrence('walk'), changed: true };
    });
    await show();
    await waitFor(() => expect(screen.queryByTestId('today-habit-done-walk')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('today-habit-done-walk'));
    expect(decide).toHaveBeenCalledWith({ habitId: 'walk', occurrenceId: `walk.${DAY}.0`, outcome: 'completed' }, 'Asia/Jerusalem');
    await waitFor(() => expect(screen.queryByTestId('today-habit-undo-walk')).not.toBeNull());
    expect(within(screen.getByTestId('today-habit-walk')).getByText(en.xHabitTodayDone)).toBeTruthy();
    expect(screen.queryByTestId('today-habit-done-walk')).toBeNull();
    expect(screen.getByTestId('today-habit-undo-walk').props.accessibilityLabel).toBe(fill(en.xHabitTodayUndoA11y, { title: isolateAuto('Walk') }));
    await fireEvent.press(screen.getByTestId('today-habit-undo-walk'));
    expect(undo).toHaveBeenCalledWith({ habitId: 'walk', occurrenceId: `walk.${DAY}.0` }, 'Asia/Jerusalem');
    await waitFor(() => expect(screen.queryByTestId('today-habit-done-walk')).not.toBeNull());
    expect(within(screen.getByTestId('today-habit-walk')).getByText(en.xHabitTodayReopened)).toBeTruthy();
  });

  it('says an undo the server refuses, in place, and keeps the day decided', async () => {
    todayAnswer = { ...todayAnswer, occurrences: [{ ...occurrence('walk'), state: 'skipped' }] };
    jest.spyOn(habitEndpoints, 'undoHabitOccurrence').mockRejectedValue(new ConflictError('made-up day decided'));
    await show();
    await waitFor(() => expect(screen.queryByTestId('today-habit-undo-walk')).not.toBeNull());
    expect(within(screen.getByTestId('today-habit-walk')).getByText(en.xHabitTodaySkipped)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('today-habit-undo-walk'));
    await waitFor(() => expect(within(screen.getByTestId('today-habit-walk')).queryByText(en.xHabitUndoMadeUpDecided)).not.toBeNull());
    expect(screen.queryByTestId('today-habit-undo-walk')).not.toBeNull();
  });

  it('sits with the day\'s commitments too, without taking their place', async () => {
    jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [commitmentFixture] } as never);
    await show();
    await waitFor(() => expect(screen.queryByTestId('today-habit-walk')).not.toBeNull());
    expect(screen.queryByTestId('today-empty')).toBeNull();
    // The count of open things is the commitments' alone.
    expect(screen.getByTestId('today-count').props.children).not.toContain('3');
  });

  it('draws no habit block when nothing is due', async () => {
    todayAnswer = { localDate: DAY, occurrences: [], anyDay: [] };
    await show();
    await waitFor(() => expect(habitEndpoints.listHabitsToday).toHaveBeenCalled());
    expect(screen.queryByTestId('today-habits')).toBeNull();
    expect(screen.queryByTestId('today-empty')).not.toBeNull();
  });

  it('keeps the day when the habits cannot be read: no block, no error in their place', async () => {
    jest.spyOn(habitEndpoints, 'listHabits').mockRejectedValue(new Error('down'));
    await show();
    await waitFor(() => expect(habitEndpoints.listHabits).toHaveBeenCalled());
    expect(screen.queryByTestId('today-habits')).toBeNull();
    expect(screen.queryByTestId('today-empty')).not.toBeNull();
  });
});
