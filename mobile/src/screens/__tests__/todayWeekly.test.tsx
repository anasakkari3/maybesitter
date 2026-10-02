/**
 * Weekly fixed blocks on Today: the day's blocks as fixed time, and the next
 * step's `weekly_block` silence said honestly — «It's training time now.
 * Suggestions are back at 16:00.» — like quiet hours, not like quiet mode.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider, useApp } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../api/auth';
import type { AuthUser } from '../../auth/types';
import { TodayScreen } from '../TodayScreen';
import en from '../../i18n/locales/en.json';
import { fill, ltr } from '../../i18n/strings';
import { isolateAuto } from '../../i18n/bidi';
import { formatTime } from '../../i18n/format';
import { Txt } from '../../ui/primitives';
import quietHoursFixture from '../../api/__fixtures__/nextStep.quietHours.json';
import profileFixture from '../../api/__fixtures__/profile.one.json';
import * as commitmentEndpoints from '../../api/endpoints/commitments';
import * as nextStepEndpoints from '../../api/endpoints/nextStep';
import * as planEndpoints from '../../api/endpoints/plans';
import * as profileEndpoints from '../../api/endpoints/profile';
import * as weeklyEndpoints from '../../api/endpoints/weeklyBlocks';

const ZONE = 'Asia/Jerusalem';
jest.mock('../../i18n/timezone', () => ({
  ...(jest.requireActual('../../i18n/timezone') as object),
  useTimeZone: () => 'Asia/Jerusalem',
}));

const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const USER: AuthUser = { uid: 'today-weekly-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'] };
const HOUR = 3_600_000;
// Started a minute ago, ends in two hours: under way whenever this runs. Today
// draws what the occurrences route answers for its window, so the date these
// fall on needs no pinning here (the window itself is `occurrences.test.ts`).
function underWay() {
  const now = Date.now();
  return { startAt: new Date(now - 60_000).toISOString(), endAt: new Date(now + 2 * HOUR).toISOString() };
}

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

function weeklyExposure(until: string | undefined) {
  return { ...quietHoursFixture, exposure: { allowed: false, reason: 'weekly_block', ...(until ? { until } : {}) } };
}

beforeEach(() => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(planEndpoints, 'getPlan').mockResolvedValue(null as never);
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
  jest.spyOn(profileEndpoints, 'getProfile').mockResolvedValue({ ...profileFixture, routine: { ...profileFixture.routine, timezone: ZONE } } as never);
});

afterEach(() => { client.clear(); resetAuthForTests(); jest.restoreAllMocks(); });

function Probe() {
  const { s } = useApp();
  return <Txt testID="screen-probe">{s.screen}</Txt>;
}

async function show() {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}><TodayScreen /><Probe /></QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('query-loading')).toBeNull());
}

describe('the next step inside a weekly block', () => {
  it('names the block and when suggestions come back, from the block\'s own end', async () => {
    const { startAt, endAt } = underWay();
    jest.spyOn(nextStepEndpoints, 'getNextStep').mockResolvedValue(weeklyExposure('23:59') as never);
    jest.spyOn(weeklyEndpoints, 'listWeeklyBlockOccurrences').mockResolvedValue([
      { occurrenceId: 'o1', weeklyBlockId: 'train', title: 'Training', startAt, endAt },
    ]);
    await show();
    const time = ltr(formatTime(new Date(endAt), { locale: 'en', timeZone: ZONE }));
    const line = fill(en.wbNextNow, { title: isolateAuto('Training'), time });
    await waitFor(() => expect(within(screen.getByTestId('today-quiet')).queryByText(line)).not.toBeNull());
    // Not quiet mode, not quiet hours.
    expect(screen.queryByText(en.todayQuietModeOn)).toBeNull();
    expect(screen.queryByTestId('today-quiet-hours')).toBeNull();
    await fireEvent.press(screen.getByTestId('today-quiet-weekly'));
    await waitFor(() => expect(screen.getByTestId('screen-probe').props.children).toBe('weeklyBlocks'));
  });

  it('falls back to the route\'s hour, and says no hour rather than a wrong one', async () => {
    jest.spyOn(weeklyEndpoints, 'listWeeklyBlockOccurrences').mockResolvedValue([]);
    jest.spyOn(nextStepEndpoints, 'getNextStep').mockResolvedValue(weeklyExposure('16:00') as never);
    await show();
    await waitFor(() => expect(screen.queryByTestId('today-quiet')).not.toBeNull());
    await waitFor(() => expect(within(screen.getByTestId('today-quiet')).queryByText(fill(en.wbNextNowGeneric, { time: ltr('16:00') }))).not.toBeNull());
  });

  it('with no hour at all, says it comes back when the block ends', async () => {
    jest.spyOn(weeklyEndpoints, 'listWeeklyBlockOccurrences').mockResolvedValue([]);
    jest.spyOn(nextStepEndpoints, 'getNextStep').mockResolvedValue(weeklyExposure(undefined) as never);
    await show();
    await waitFor(() => expect(within(screen.getByTestId('today-quiet')).queryByText(en.wbNextNowNoTime)).not.toBeNull());
  });
});

describe('the day\'s blocks', () => {
  it('are listed as fixed time, even on an otherwise empty day', async () => {
    const { startAt, endAt } = underWay();
    jest.spyOn(nextStepEndpoints, 'getNextStep').mockResolvedValue({
      success: true, participantId: USER.uid,
      recommendation: { version: 'v1', proposalId: 'e', state: 'empty', locale: 'en', primaryStep: null, explanation: null },
    } as never);
    jest.spyOn(weeklyEndpoints, 'listWeeklyBlockOccurrences').mockResolvedValue([
      { occurrenceId: 'o1', weeklyBlockId: 'train', title: 'Training', startAt, endAt },
    ]);
    await show();
    // Folded to one line that names it (Stitch); open, it is the row.
    await waitFor(() => expect(screen.queryByTestId('today-weekly-toggle')).not.toBeNull());
    expect(screen.getByTestId('today-weekly-toggle').props.accessibilityLabel).toContain('Training');
    await fireEvent.press(screen.getByTestId('today-weekly-toggle'));
    await waitFor(() => expect(screen.queryByTestId('today-weekly-train')).not.toBeNull());
    expect(screen.getByTestId('today-weekly-train').props.accessibilityLabel).toContain(en.wbFixedTag);
    expect(screen.getByText(en.wbTodayTitle)).toBeTruthy();
    // No «done» on a fixed block.
    expect(within(screen.getByTestId('today-weekly')).queryByLabelText(en.doneS)).toBeNull();
  });
});
