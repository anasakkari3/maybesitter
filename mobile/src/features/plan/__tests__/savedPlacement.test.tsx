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
import * as consentEndpoints from '../../../api/endpoints/consents';
import * as planEndpoints from '../../../api/endpoints/plans';
import nextStepFixture from '../../../api/__fixtures__/nextStep.recommendation.json';
import consentsFixture from '../../../api/__fixtures__/consents.answered.json';
import { instantAt } from '../../../testing/wallClock';
import { toViewModel } from '../../commitments/model';
import { drawnWhen } from '../savedPlacement';

jest.mock('../../../i18n/timezone', () => ({
  ...(jest.requireActual('../../../i18n/timezone') as object),
  useTimeZone: () => 'Asia/Jerusalem',
}));

const ZONE = 'Asia/Jerusalem';
const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const USER: AuthUser = { uid: 'week-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'] };
const TODAY_KEY = dayKey(new Date(), ZONE);

/**
 * `hour`:00 in Jerusalem on the day `offset` days from today. The offset is
 * the zone's own on that day — a literal +03:00 made this suite fail once the
 * days it builds crossed the end of summer time (last Sunday of October).
 */
function at(offset: number, hour: number): string {
  const key = shiftDayKey(TODAY_KEY, offset);
  return instantAt(`${key}T${String(hour).padStart(2, '0')}:00:00`, ZONE);
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
  jest.spyOn(consentEndpoints, 'getConsents').mockResolvedValue(consentsFixture as never);
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

  it('the next-step card on Today says it the same way, when the saved-week step is the next step (review I1)', async () => {
    // The recorded recommendation, pointed at the step saved for Thursday.
    const dueToday = { ...market(), timeSpec: { ...market().timeSpec, dueAt: at(0, 23), remindAt: at(0, 23) } };
    jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [dueToday] } as never);
    jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
    jest.spyOn(nextStepEndpoints, 'getNextStep').mockResolvedValue({
      ...nextStepFixture,
      recommendation: { ...nextStepFixture.recommendation, primaryStep: { commitmentId: 'market', title: 'Go to the market' } },
    } as never);
    await show(<TodayScreen />);
    await waitFor(() => expect(screen.queryByTestId('next-step-title')).not.toBeNull());
    await waitFor(() => expect(screen.getByTestId('next-step-when').props.children).toBe(when(PLANNED)));
    const aside = fill(en.plannedDueAside, { when: when(at(0, 23)) });
    expect(screen.getByTestId('next-step-due').props.children).toBe(aside);
    expect(screen.getByTestId('next-step-open').props.accessibilityLabel).toContain(aside);
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
    expect(en.plannedDueAside).toBe('Due: {when}');
    expect(he.plannedDueAside).toBe('המועד: {when}');
    expect([ar.plannedRowLabel, en.plannedRowLabel, he.plannedRowLabel]).toEqual(['بخطتك', 'In your plan', 'בתוכנית שלך']);
  });
});

/*
 * FX1 × FX3 (closure integration): the saved-placement helpers are how
 * Today, the next-step card and the Calendar draw a time now, so they have to
 * keep FX3's rule — an all-day deadline («قبل آخر الشهر») has a day and no
 * hour, and its local midnight is never printed as «00:00».
 */
describe('an all-day deadline, through the same helpers (FX1 × FX3)', () => {
  const midnight = (offset: number) => instantAt(`${shiftDayKey(TODAY_KEY, offset)}T00:00:00`, ZONE);
  const allDay = (offset: number): Commitment => ({
    ...market(),
    timeSpec: { kind: 'due_by', dueAt: midnight(offset), endAt: null, remindAt: null, allDay: true, timezone: ZONE },
  } as Commitment);
  const MIDNIGHT = ltr(formatTime(new Date(midnight(0)), { locale: 'en', timeZone: ZONE }));
  const dayOf = (offset: number) => formatRelativeDay(new Date(midnight(offset)), { locale: 'en', timeZone: ZONE });

  beforeEach(() => { savedWeek = { today: TODAY_KEY, saved: [] }; });

  it('Today: an all-day item due today says «no time», not 00:00', async () => {
    jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [allDay(0)] } as never);
    jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
    await show(<TodayScreen />);
    await waitFor(() => expect(screen.queryByTestId('today-time-market')).not.toBeNull());
    expect(screen.getByTestId('today-time-market').props.children).toBe(en.noTimeYet);
    expect(screen.getByTestId('today-item-market').props.accessibilityLabel).not.toContain(MIDNIGHT);
  });

  it('Today «بعدين»: its day, and «no time» in the hour\'s place', async () => {
    jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [allDay(2)] } as never);
    await show(<TodayScreen />);
    await waitFor(() => expect(screen.queryByTestId('today-later-when-market')).not.toBeNull());
    expect(screen.getByTestId('today-later-when-market').props.children).toBe(`${dayOf(2)} · ${en.noTimeYet}`);
  });

  it('the next-step card: no 00:00', async () => {
    jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [allDay(0)] } as never);
    jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
    jest.spyOn(nextStepEndpoints, 'getNextStep').mockResolvedValue({
      ...nextStepFixture,
      recommendation: { ...nextStepFixture.recommendation, primaryStep: { commitmentId: 'market', title: 'Go to the market' } },
    } as never);
    await show(<TodayScreen />);
    await waitFor(() => expect(screen.queryByTestId('next-step-when')).not.toBeNull());
    expect(screen.getByTestId('next-step-when').props.children).toBe(en.noTimeYet);
  });

  it('the Calendar: «no time» on its day', async () => {
    jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [allDay(2)] } as never);
    await show(<CalendarScreen />);
    await waitFor(() => expect(screen.queryByTestId(`calendar-day-${shiftDayKey(TODAY_KEY, 2)}`)).not.toBeNull());
    await fireEvent.press(screen.getByTestId(`calendar-day-${shiftDayKey(TODAY_KEY, 2)}`));
    await waitFor(() => expect(screen.queryByTestId('calendar-item-market')).not.toBeNull());
    expect(screen.getByTestId('calendar-time-market').props.children).toBe(en.noTimeYet);
    expect(screen.getByTestId('calendar-item-market').props.accessibilityLabel).not.toContain(MIDNIGHT);
  });

  it('saved to a slot on another day: the slot is an hour, and the due beside it is a day with no hour', async () => {
    jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [allDay(5)] } as never);
    savedWeek = { today: TODAY_KEY, saved: [{ date: shiftDayKey(TODAY_KEY, 4), items: [{ itemId: 'market', startsAt: PLANNED, endsAt: at(4, 10) }] }] };
    await show(<TodayScreen />);
    await waitFor(() => expect(screen.getByTestId('today-later-when-market').props.children).toBe(when(PLANNED)));
    expect(screen.getByTestId('today-later-due-market').props.children).toBe(fill(en.plannedDueAside, { when: dayOf(5) }));
  });
});

/**
 * A due on another day, with no saved plan (owner's Redmi, 2026-09-29).
 *
 * The only open commitment was a task due Tue 15 Sep 09:00, two weeks late.
 * The next-step card read «Doctor · 09:00 · Must» beside «the time has
 * passed» — the hour with no day, so it read as today at 09:00 and the chip
 * as a lie about the last few minutes. Today's rows did the same. Wherever a
 * commitment's time is drawn on Today, a due that is not today says its day,
 * the way «بعدين», Details and the review card already say it; today's items
 * keep the hour alone.
 */
describe('a due on another day says its day (owner\'s Redmi, 2026-09-29)', () => {
  const LATE = at(-14, 9);
  const late = (over: Partial<Commitment['timeSpec']> = {}): Commitment => ({
    ...market(),
    priority: { level: 'high', source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' },
    timeSpec: { kind: 'due_by', dueAt: LATE, endAt: null, remindAt: null, allDay: false, timezone: 'UTC', ...over },
  } as Commitment);
  const lateCard = {
    ...nextStepFixture,
    recommendation: { ...nextStepFixture.recommendation, primaryStep: { commitmentId: 'market', title: 'Go to the market' } },
  };

  beforeEach(() => {
    savedWeek = { today: TODAY_KEY, saved: [] };
    jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
  });

  it('the next-step card: the day and the hour, beside «the time has passed»', async () => {
    jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [late()] } as never);
    jest.spyOn(nextStepEndpoints, 'getNextStep').mockResolvedValue(lateCard as never);
    await show(<TodayScreen />);
    await waitFor(() => expect(screen.queryByTestId('next-step-when')).not.toBeNull());
    expect(screen.getByTestId('next-step-when').props.children).toBe(when(LATE));
    expect(screen.getByText(en.evidenceOverdue)).toBeTruthy();
  });

  it('a Today row: the day and the hour, on the row and in its spoken name', async () => {
    jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [late()] } as never);
    await show(<TodayScreen />);
    await waitFor(() => expect(screen.queryByTestId('today-time-market')).not.toBeNull());
    expect(screen.getByTestId('today-time-market').props.children).toBe(when(LATE));
    expect(screen.getByTestId('today-item-market').props.accessibilityLabel).toContain(when(LATE));
  });

  it('an all-day item whose day is over: its day, not «no time»', async () => {
    const dayStart = instantAt(`${shiftDayKey(TODAY_KEY, -3)}T00:00:00`, ZONE);
    jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [late({ dueAt: dayStart, allDay: true, timezone: ZONE })] } as never);
    await show(<TodayScreen />);
    await waitFor(() => expect(screen.queryByTestId('today-time-market')).not.toBeNull());
    const day = formatRelativeDay(new Date(dayStart), { locale: 'en', timeZone: ZONE });
    expect(screen.getByTestId('today-time-market').props.children).toBe(day);
    expect(screen.getByTestId('today-item-market').props.accessibilityLabel).toContain(day);
  });

  it('today\'s item keeps the hour alone', async () => {
    const TODAY_9 = at(0, 9);
    jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [late({ dueAt: TODAY_9 })] } as never);
    await show(<TodayScreen />);
    await waitFor(() => expect(screen.queryByTestId('today-time-market')).not.toBeNull());
    expect(screen.getByTestId('today-time-market').props.children).toBe(ltr(formatTime(new Date(TODAY_9), { locale: 'en', timeZone: ZONE })));
  });

  it('Details already says its day, apart from the hour', async () => {
    jest.spyOn(commitmentEndpoints, 'getCommitment').mockResolvedValue({ data: late(), etag: 'W/"v1"' } as never);
    await show(<><OpenDetails /><DetailsScreen /></>);
    await waitFor(() => expect(screen.queryByTestId('details-day')).not.toBeNull());
    expect(String(screen.getByTestId('details-day').props.children)).toContain(formatRelativeDay(new Date(LATE), { locale: 'en', timeZone: ZONE }));
  });

  it('in all three languages, as the review card writes a day and an hour', () => {
    for (const lang of ['ar', 'en', 'he'] as const) {
      const view = toViewModel(late(), new Date().toISOString());
      const expected = `${formatRelativeDay(new Date(LATE), { locale: lang, timeZone: ZONE })} · ${ltr(formatTime(new Date(LATE), { locale: lang, timeZone: ZONE }))}`;
      expect(drawnWhen(view, lang, ZONE)).toBe(expected);
      // A weekday with its date, not «today»: the lateness is in the words.
      expect(expected.startsWith((lang === 'ar' ? ar : lang === 'he' ? he : en).today)).toBe(false);
    }
  });
});
