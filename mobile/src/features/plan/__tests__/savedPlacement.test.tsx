/**
 * After a weekly save, one answer to "when" on every screen (post-UAT FX1).
 *
 * The 2026-09-27 run: «أروح عالسوق», due tomorrow 15:00, was moved to
 * Thursday in «خطّط أسبوعي» and saved there. The Calendar then drew it on
 * Thursday at 09:00 while Today's «بعدين» and Details still said «بكرا ·
 * 15:00», each with nothing to say that the other existed (shots 69, 76, 77).
 *
 * The model is the daily plan's: the commitment keeps its own due, and where
 * a saved plan puts it is shown as its time — on Today, the Calendar and
 * Details alike — with its own due beside it, once, when the two differ.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider, useApp } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import type { Commitment } from '../../../api/schemas/common';
import type { SavedWeek } from '../../../api/schemas/plan';
import { TodayScreen } from '../../../screens/TodayScreen';
import { CalendarScreen } from '../../../screens/CalendarScreen';
import { DetailsScreen } from '../../../screens/DetailsScreen';
import { dayKey, formatRelativeDay, formatTime, shiftDayKey } from '../../../i18n/format';
import { fill, ltr } from '../../../i18n/strings';
import en from '../../../i18n/locales/en.json';
import ar from '../../../i18n/locales/ar.json';
import he from '../../../i18n/locales/he.json';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as nextStepEndpoints from '../../../api/endpoints/nextStep';
import * as planEndpoints from '../../../api/endpoints/plans';

jest.mock('../../../i18n/timezone', () => ({
  ...(jest.requireActual('../../../i18n/timezone') as object),
  useTimeZone: () => 'Asia/Jerusalem',
}));

const ZONE = 'Asia/Jerusalem';
const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const USER: AuthUser = { uid: 'week-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'] };
const TODAY_KEY = dayKey(new Date(), ZONE);

/** `hour`:00 local on the day `offset` days from today. Jerusalem is +03 until late October. */
function at(offset: number, hour: number): string {
  const key = shiftDayKey(TODAY_KEY, offset);
  return new Date(`${key}T${String(hour).padStart(2, '0')}:00:00.000+03:00`).toISOString();
}

const DUE = at(1, 15);
const PLANNED = at(4, 9);

function market(): Commitment {
  return {
    id: 'market', kind: 'task', title: 'Go to the market', description: null, person: null, status: 'active',
    priority: { level: 'normal', source: 'inferred', pressureAllowed: false, pressureLevel: 'none' },
    category: null, categorySource: 'inferred',
    timeSpec: { kind: 'due_by', dueAt: DUE, endAt: null, remindAt: DUE, allDay: false, timezone: ZONE },
    currentAckState: 'not_seen', postponedUntil: null,
    createdAt: at(0, 9), updatedAt: at(0, 9), confirmedAt: at(0, 9), completedAt: null, droppedAt: null,
  } as Commitment;
}

const SAVED_THURSDAY: SavedWeek = {
  today: TODAY_KEY,
  saved: [{ date: shiftDayKey(TODAY_KEY, 4), items: [{ itemId: 'market', startsAt: PLANNED, endsAt: at(4, 10) }] }],
};

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;
let savedWeek: SavedWeek;

beforeEach(() => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  savedWeek = SAVED_THURSDAY;
  jest.spyOn(planEndpoints, 'getSavedWeek').mockImplementation(async () => savedWeek);
  jest.spyOn(planEndpoints, 'getPlan').mockResolvedValue(null as never);
  jest.spyOn(nextStepEndpoints, 'getNextStep').mockResolvedValue({
    success: true, participantId: USER.uid,
    recommendation: { version: 'v1', proposalId: 'next-step-empty', state: 'empty', locale: 'en', primaryStep: null, explanation: null },
  } as never);
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [market()] } as never);
  jest.spyOn(commitmentEndpoints, 'getCommitment').mockResolvedValue({ data: market(), etag: 'W/"v1"' } as never);
});

afterEach(() => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

function OpenDetails() {
  const { actions } = useApp();
  const opened = React.useRef(false);
  React.useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    actions.openDetail('market');
  }, [actions]);
  return null;
}

async function show(child: React.ReactNode) {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}>{child}</QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

const when = (iso: string) => `${formatRelativeDay(new Date(iso), { locale: 'en', timeZone: ZONE })} · ${ltr(formatTime(new Date(iso), { locale: 'en', timeZone: ZONE }))}`;
const dueAside = fill(en.plannedDueAside, { when: when(DUE) });

describe('a step saved for another day, after «احفظ هاليوم»', () => {
  it('Today «بعدين» shows it where the saved plan put it, and its own due beside it', async () => {
    await show(<TodayScreen />);
    await waitFor(() => expect(screen.queryByTestId('today-later-market')).not.toBeNull());
    await waitFor(() => expect(screen.getByTestId('today-later-when-market').props.children).toBe(when(PLANNED)));
    expect(screen.getByTestId('today-later-due-market').props.children).toBe(dueAside);
    // Said out loud as well: the planned time and the due are both in the row's name.
    expect(screen.getByTestId('today-later-market').props.accessibilityLabel).toContain(dueAside);
  });

  it('a today item saved for a later day says that day on its row, and its due beside it', async () => {
    const dueToday = { ...market(), timeSpec: { ...market().timeSpec, dueAt: at(0, 23), remindAt: at(0, 23) } };
    jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [dueToday] } as never);
    jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
    await show(<TodayScreen />);
    await waitFor(() => expect(screen.getByTestId('today-time-market').props.children).toBe(when(PLANNED)));
    expect(screen.getByTestId('today-due-market').props.children).toBe(fill(en.plannedDueAside, { when: when(at(0, 23)) }));
  });

  it('Details says the same two things: where it is planned, and when it is due', async () => {
    await show(<><OpenDetails /><DetailsScreen /></>);
    await waitFor(() => expect(screen.queryByTestId('details-title')).not.toBeNull());
    await waitFor(() => expect(screen.getByTestId('details-planned').props.children).toBe(when(PLANNED)));
    expect(screen.getByText(en.plannedRowLabel)).toBeTruthy();
    // Its own day and time are still its own: Edit changes those, not the plan.
    expect(screen.getByTestId('details-time').props.children).toBe(ltr(formatTime(new Date(DUE), { locale: 'en', timeZone: ZONE })));
  });

  it('the Calendar draws it on the saved day and says its due, as Today does', async () => {
    await show(<CalendarScreen />);
    await waitFor(() => expect(screen.queryByTestId(`calendar-day-${TODAY_KEY}`)).not.toBeNull());
    await waitFor(() => expect(screen.queryAllByTestId(`calendar-bar-${shiftDayKey(TODAY_KEY, 4)}`)).toHaveLength(1));
    await fireEvent.press(screen.getByTestId(`calendar-day-${shiftDayKey(TODAY_KEY, 4)}`));
    await waitFor(() => expect(screen.queryByTestId('calendar-item-market')).not.toBeNull());
    expect(screen.getByTestId('calendar-time-market').props.children).toBe(ltr(formatTime(new Date(PLANNED), { locale: 'en', timeZone: ZONE })));
    expect(screen.getByTestId('calendar-due-market').props.children).toBe(dueAside);
  });

  it('nothing extra is said when the saved plan keeps it at its own time, or when nothing is saved', async () => {
    savedWeek = { today: TODAY_KEY, saved: [{ date: shiftDayKey(TODAY_KEY, 1), items: [{ itemId: 'market', startsAt: DUE, endsAt: at(1, 16) }] }] };
    await show(<TodayScreen />);
    await waitFor(() => expect(screen.queryByTestId('today-later-market')).not.toBeNull());
    await waitFor(() => expect(planEndpoints.getSavedWeek).toHaveBeenCalled());
    expect(screen.getByTestId('today-later-when-market').props.children).toBe(when(DUE));
    expect(screen.queryByTestId('today-later-due-market')).toBeNull();
  });

  it('the aside is short and spoken in all three languages', () => {
    expect(ar.plannedDueAside).toBe('موعدها {when}');
    expect(en.plannedDueAside).toBe('Due {when}');
    expect(he.plannedDueAside).toBe('המועד: {when}');
    expect([ar.plannedRowLabel, en.plannedRowLabel, he.plannedRowLabel]).toEqual(['بخطّتك', 'In your plan', 'בתוכנית שלך']);
  });
});
