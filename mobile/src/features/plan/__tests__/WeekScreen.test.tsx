/**
 * «خطّط أسبوعي» — the Week screen (CL5b).
 *
 * The week comes from `plan.week.json`, which the fixture exporter records
 * from the real route, so these cases are about the shape the server sends:
 * two days that already have plans, proposal days with one step each, a fixed
 * row. The hooks are replaced so each case can say which week the server
 * answered and see exactly which decisions the screen asked it for.
 *
 * The two entry points are held here too: «اختار شو بدك تعمل» and the
 * Calendar tab's header (the latter in `calendarScreen.test.tsx`).
 */
import React from 'react';
import { AccessibilityInfo, Text } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider, useApp } from '../../../state/AppContext';
import { strings } from '../../../i18n/strings';
import { isolateAuto } from '../../../i18n/bidi';
import { weekResponseSchema, type Week } from '../../../api/schemas/plan';
import fixture from '../../../api/__fixtures__/plan.week.json';
import type { WeekDecisions } from '../../../api/endpoints/plans';
import { ConflictError, QuotaExceededError, WeekConflictError } from '../../../api/errors';
import { WeekScreen } from '../WeekScreen';
import { ActionModesScreen } from '../../product/ControlScreens';

const RECORDED: Week = weekResponseSchema.parse(fixture).week;
const PROPOSED = RECORDED.days.filter(day => day.state === 'proposed');
const WITH_STEP = PROPOSED.filter(day => day.items.length > 0);
const FIRST = WITH_STEP[0]!;
const STEP = FIRST.items[0]!;

let mockWeek: Week | undefined = RECORDED;
let mockFetching = false;
let mockPlaceholder = false;
let mockWeekError: unknown = null;
let mockSaveError: unknown = null;
let mockSaving = false;
let mockSaveVariables: { date: string; shown: string[] } | undefined;
const mockDecisions: WeekDecisions[] = [];
const mockSave = jest.fn();

jest.mock('../../../api/queries', () => ({
  useWeek: (decisions: WeekDecisions) => {
    mockDecisions.push(decisions);
    return {
      data: mockWeek,
      isPending: mockWeek === undefined && mockWeekError === null,
      isFetching: mockFetching,
      isPlaceholderData: mockPlaceholder,
      error: mockWeekError,
      refetch: jest.fn(),
    };
  },
  useAcceptWeekDay: () => ({
    mutate: mockSave,
    isPending: mockSaving,
    isError: mockSaveError !== null,
    error: mockSaveError,
    variables: mockSaveVariables,
  }),
  // Imported by the other screens in ControlScreens; never rendered here.
  usePlan: () => ({ data: null, isPending: false, error: null, refetch: jest.fn() }),
  usePlanAction: () => ({ mutate: jest.fn(), isPending: false, error: null }),
  useHabits: () => ({ data: [], isPending: false, error: null, refetch: jest.fn() }),
  useCreateHabit: () => ({ mutate: jest.fn(), isPending: false, error: null }),
  useSetHabitStatus: () => ({ mutate: jest.fn(), isPending: false, error: null }),
  useDeleteHabit: () => ({ mutate: jest.fn(), isPending: false, error: null }),
}));

function Probe() {
  const { s } = useApp();
  return <Text testID="probe-screen">{s.screen}</Text>;
}

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const show = (child: React.ReactNode = <WeekScreen />) => render(
  <SafeAreaProvider initialMetrics={metrics}><AppProvider>{child}<Probe /></AppProvider></SafeAreaProvider>,
);

/** The bundle the provider rendered in, found by a string only that bundle has on screen. */
function language() {
  return Object.values(strings).find(bundle => screen.queryAllByText(bundle.weekTitle).length > 0)!;
}

const lastDecisions = () => mockDecisions[mockDecisions.length - 1]!;

/** What the card for `day` shows, as "Save" sends it (I1). */
const shownOn = (day: Week['days'][number]) => [...day.items.map(item => item.itemId), ...day.unplaced.map(item => item.itemId)];

beforeEach(() => {
  mockWeek = RECORDED;
  mockFetching = false;
  mockPlaceholder = false;
  mockWeekError = null;
  mockSaveError = null;
  mockSaving = false;
  mockSaveVariables = undefined;
  mockDecisions.length = 0;
  mockSave.mockReset();
});
afterEach(async () => {
  await cleanup();
  jest.restoreAllMocks();
});

describe('the week', () => {
  it('draws one card per day, today and the six after it, and says it is a suggestion', async () => {
    await show();
    const t = language();
    expect(RECORDED.days).toHaveLength(7);
    for (const day of RECORDED.days) expect(screen.getByTestId(`week-day-${day.date}`)).toBeTruthy();
    expect(screen.getByTestId('week-proposal-note').props.children).toBe(t.suggestionNote);
    // Nothing is decided when the screen opens.
    expect(mockDecisions[0]).toEqual({ moves: [], drops: [] });
  });

  it('names each day\'s state in words: a suggestion, a plan, or saved', async () => {
    await show();
    const t = language();
    for (const day of RECORDED.days) {
      const expected = day.state === 'proposed' ? t.weekProposal : day.state === 'planned' ? t.weekPlanned : t.weekSaved;
      expect(screen.getByTestId(`week-state-${day.date}`).props.children).toBe(expected);
    }
  });

  it('shows the proposed step with why it is on its day, as one accessible element', async () => {
    await show();
    const t = language();
    const row = screen.getByTestId(`week-step-${STEP.itemId}`);
    // Titles are the person's own words, isolated so their direction is their own.
    expect(within(row).getByText(new RegExp(STEP.title!))).toBeTruthy();
    const reasonKey = { due: 'weekReasonDue', due_later: 'weekReasonDueLater', due_earlier: 'weekReasonDueEarlier', carried: 'weekReasonCarried', open: 'weekReasonOpen', moved: 'weekReasonMoved' } as const;
    expect(within(row).getByText(t[reasonKey[STEP.reason!]])).toBeTruthy();
    expect(within(row).getAllByLabelText(new RegExp(STEP.title!)).length).toBeGreaterThan(0);
  });

  it('a step due on an earlier day still ahead says so, not «من يوم فات» (FX1)', async () => {
    // The server's `due_earlier`: due tomorrow, offered the day after.
    mockWeek = {
      ...RECORDED,
      days: RECORDED.days.map(day => day.date === FIRST.date
        ? { ...day, items: day.items.map(item => item.itemId === STEP.itemId ? { ...item, reason: 'due_earlier' as const } : item) }
        : day),
    };
    await show();
    const t = language();
    const row = screen.getByTestId(`week-step-${STEP.itemId}`);
    expect(within(row).getByText(t.weekReasonDueEarlier)).toBeTruthy();
    expect(within(row).queryByText(t.weekReasonCarried)).toBeNull();
    expect(strings.ar.weekReasonDueEarlier).toBe('موعدها قبل هاليوم');
  });

  it('a step pulled ahead of its due day says it is due after this day, not «موعدها بهاليوم» (N3)', async () => {
    mockWeek = {
      ...RECORDED,
      days: RECORDED.days.map(day => day.date === FIRST.date
        ? { ...day, items: day.items.map(item => item.itemId === STEP.itemId ? { ...item, reason: 'due_later' as const } : item) }
        : day),
    };
    // The server mints `due_later` (weekPlan.ts); the phone's schema must take it.
    expect(weekResponseSchema.safeParse({ ...(fixture as object), week: mockWeek }).success).toBe(true);
    await show();
    const t = language();
    const row = screen.getByTestId(`week-step-${STEP.itemId}`);
    expect(within(row).getByText(t.weekReasonDueLater)).toBeTruthy();
    expect(within(row).queryByText(t.weekReasonDue)).toBeNull();
    expect([strings.ar.weekReasonDueLater, strings.en.weekReasonDueLater, strings.he.weekReasonDueLater])
      .toEqual(['موعدها بعد هاليوم', 'Due after this day', 'המועד אחרי היום הזה']);
  });

  it('a saved day keeps each row\'s due line, spoken with the row (N3, 174)', async () => {
    // The recorded week's saved days, as the server sends them: every row has its reason.
    await show();
    const t = language();
    const saved = RECORDED.days.filter(day => day.state !== 'proposed' && day.items.length > 0);
    expect(saved.length).toBeGreaterThan(0);
    for (const day of saved) {
      for (const item of day.items) {
        expect(item.reason).not.toBeNull();
        const card = screen.getByTestId(`week-day-${day.date}`);
        const row = within(card).getByTestId(`week-row-${item.itemId}`);
        const line = t[({ due: 'weekReasonDue', due_later: 'weekReasonDueLater', due_earlier: 'weekReasonDueEarlier', carried: 'weekReasonCarried', open: 'weekReasonOpen', moved: 'weekReasonMoved' } as const)[item.reason!]];
        expect(within(row).getByTestId(`week-row-reason-${item.itemId}`).props.children).toBe(line);
        expect(row.props.accessibilityLabel).toContain(line);
      }
    }
  });

  it('the UAT market, saved on Wednesday and due Monday, still says «موعدها قبل هاليوم» once saved (174)', async () => {
    const savedDay = RECORDED.days.find(day => day.state !== 'proposed' && day.items.length > 0)!;
    const row = savedDay.items[0]!;
    mockWeek = {
      ...RECORDED,
      days: RECORDED.days.map(day => day.date === savedDay.date
        ? { ...day, state: 'accepted' as const, items: [{ ...row, reason: 'due_earlier' as const }, ...day.items.slice(1)] }
        : day),
    };
    await show();
    const t = language();
    const card = screen.getByTestId(`week-day-${savedDay.date}`);
    expect(within(card).getByTestId(`week-row-reason-${row.itemId}`).props.children).toBe(t.weekReasonDueEarlier);
    expect(within(card).getByTestId(`week-row-${row.itemId}`).props.accessibilityLabel).toContain(t.weekReasonDueEarlier);
  });

  it('shows a fixed-time commitment as a fixed row, not a button', async () => {
    await show();
    const t = language();
    const fixedDay = RECORDED.days.find(day => day.fixed.length > 0)!;
    const row = screen.getByTestId(`week-fixed-${fixedDay.fixed[0]!.itemId}`);
    expect(within(row).getByText(t.planItemFixed)).toBeTruthy();
    expect(row.props.accessibilityRole).toBe('text');
  });

  it('says a day with nothing on it is free rather than drawing it empty', async () => {
    await show();
    const t = language();
    const free = RECORDED.days.find(day => day.items.length === 0 && day.fixed.length === 0 && day.allDay.length === 0)!;
    expect(screen.getByTestId(`week-free-${free.date}`).props.children).toBe(t.weekFreeDay);
    expect(screen.queryByTestId(`week-save-${free.date}`)).toBeNull();
  });

  it('shows an all-day appointment on its day as a fixed all-day row, from the real route (UAT round 3, N13)', async () => {
    await show();
    const t = language();
    const day = RECORDED.days.find(candidate => candidate.allDay.length > 0)!;
    const appointment = day.allDay[0]!;
    const row = within(screen.getByTestId(`week-day-${day.date}`)).getByTestId(`week-allday-${appointment.itemId}`);
    expect(within(row).getByText(isolateAuto(appointment.title!))).toBeTruthy();
    expect(within(row).getByText(t.noTimeYet)).toBeTruthy();
    expect(within(row).getByText(t.planItemFixed)).toBeTruthy();
    // One element for a screen reader, and nothing to press: never a step.
    expect(row.props.accessibilityRole).toBe('text');
    expect(row.props.accessibilityLabel).toContain(t.noTimeYet);
    expect(screen.queryByTestId(`week-step-${appointment.itemId}`)).toBeNull();
    expect(screen.queryByTestId(`week-move-${appointment.itemId}`)).toBeNull();
    expect(screen.queryByTestId(`week-drop-${appointment.itemId}`)).toBeNull();
  });

  it('a day holding only an all-day appointment is not «يوم فاضي», and has nothing to save (UAT round 3, N13)', async () => {
    const appointment = { itemId: 'dentist', title: 'موعد أسنان' };
    const target = PROPOSED[PROPOSED.length - 1]!;
    mockWeek = {
      ...RECORDED,
      days: RECORDED.days.map(day => (day.date === target.date ? { ...day, items: [], fixed: [], unplaced: [], allDay: [appointment] } : day)),
    };
    await show();
    expect(screen.queryByTestId(`week-free-${target.date}`)).toBeNull();
    expect(within(screen.getByTestId(`week-day-${target.date}`)).getByTestId('week-allday-dentist')).toBeTruthy();
    expect(screen.queryByTestId(`week-save-${target.date}`)).toBeNull();
  });

  it('a week holding only all-day appointments is not an empty week (UAT round 3, N13)', async () => {
    mockWeek = {
      ...RECORDED,
      days: RECORDED.days.map((day, index) => ({
        ...day, state: 'proposed' as const, items: [], fixed: [], unplaced: [],
        allDay: index === 5 ? [{ itemId: 'dentist', title: 'موعد أسنان' }] : [],
      })),
      drops: [],
      waiting: 0,
    };
    await show();
    expect(screen.queryByTestId('week-empty')).toBeNull();
    expect(screen.getByTestId('week-allday-dentist')).toBeTruthy();
  });

  it('says so when there is nothing to place this week', async () => {
    mockWeek = { ...RECORDED, days: RECORDED.days.map(day => ({ ...day, state: 'proposed' as const, items: [], fixed: [], allDay: [], unplaced: [] })), drops: [], waiting: 0 };
    await show();
    const t = language();
    expect(within(screen.getByTestId('week-empty')).getByText(t.weekEmpty)).toBeTruthy();
  });
});

describe('saving a day', () => {
  it('saves exactly the day pressed, once, and says it was saved', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    await show();
    const t = language();
    await fireEvent.press(screen.getByTestId(`week-save-${FIRST.date}`));
    expect(mockSave).toHaveBeenCalledTimes(1);
    // The day, and the steps its card showed, so the server saves only what was seen (I1).
    expect(mockSave.mock.calls[0]![0]).toEqual({ date: FIRST.date, shown: shownOn(FIRST) });
    const options = mockSave.mock.calls[0]![1] as { onSuccess: () => void };
    options.onSuccess();
    expect(announce).toHaveBeenCalledWith(t.weekSavedToast);
  });

  it('holds every save while one is in flight', async () => {
    mockSaving = true;
    mockSaveVariables = { date: FIRST.date, shown: shownOn(FIRST) };
    await show();
    for (const day of WITH_STEP) {
      const button = screen.getByTestId(`week-save-${day.date}`);
      expect(button.props.accessibilityState).toMatchObject({ disabled: true });
      await fireEvent.press(button);
    }
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('says a day already has a plan in words, beside that day', async () => {
    mockSaveError = new ConflictError('that day already has a plan');
    mockSaveVariables = { date: FIRST.date, shown: shownOn(FIRST) };
    await show();
    const t = language();
    expect(screen.getByTestId(`week-error-${FIRST.date}`).props.children).toBe(t.weekAlreadyPlanned);
  });

  for (const [name, state] of [['being fetched', 'fetching'], ['the previous week kept on screen', 'placeholder']] as const) {
    it(`holds every save while the week on screen is ${name} (I1)`, async () => {
      if (state === 'fetching') mockFetching = true;
      else mockPlaceholder = true;
      await show();
      for (const day of WITH_STEP) {
        const button = screen.getByTestId(`week-save-${day.date}`);
        expect(button.props.accessibilityState).toMatchObject({ disabled: true });
        await fireEvent.press(button);
      }
      expect(mockSave).not.toHaveBeenCalled();
    });
  }

  it('says briefly that the week changed when the server refuses a stale card (I1)', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    await show();
    const t = language();
    await fireEvent.press(screen.getByTestId(`week-save-${FIRST.date}`));
    const options = mockSave.mock.calls[0]![1] as { onError: (error: unknown) => void };
    options.onError(new WeekConflictError('week_changed', RECORDED));
    expect(announce).toHaveBeenCalledWith(t.weekChanged);
    await cleanup();

    mockSaveError = new WeekConflictError('week_changed', RECORDED);
    mockSaveVariables = { date: FIRST.date, shown: shownOn(FIRST) };
    await show();
    expect(screen.getByTestId(`week-error-${FIRST.date}`).props.children).toBe(language().weekChanged);
  });

  it('says the day\'s limit is reached, not a generic failure, when the server answers 429 (I5)', async () => {
    mockWeek = undefined;
    mockWeekError = new QuotaExceededError('user_daily', 60, 'too many week plans today');
    await show();
    const t = language();
    expect(within(screen.getByTestId('week-limit')).getByText(t.weekLimitReached)).toBeTruthy();
    await cleanup();

    mockWeek = RECORDED;
    mockWeekError = null;
    mockSaveError = new QuotaExceededError('user_daily', 60, 'too many week plans today');
    mockSaveVariables = { date: FIRST.date, shown: shownOn(FIRST) };
    await show();
    expect(screen.getByTestId(`week-error-${FIRST.date}`).props.children).toBe(language().weekLimitReached);
  });

  it('opens a day that has a plan on the plan screen for that date', async () => {
    await show();
    const planned = RECORDED.days.find(day => day.state !== 'proposed')!;
    expect(screen.queryByTestId(`week-save-${planned.date}`)).toBeNull();
    await fireEvent.press(screen.getByTestId(`week-open-${planned.date}`));
    expect(screen.getByTestId('probe-screen').props.children).toBe('plan');
  });
});

describe('moving and dropping', () => {
  it('moves a step only onto another day that is still a suggestion', async () => {
    await show();
    await fireEvent.press(screen.getByTestId(`week-move-${STEP.itemId}`));
    const chooser = screen.getByTestId(`week-move-to-${STEP.itemId}`);
    const targets = PROPOSED.filter(day => day.date !== FIRST.date).map(day => day.date);
    // One-shot actions, not a selection (M-c): buttons, and no radio group around them.
    for (const date of targets) expect(within(chooser).getByTestId(`week-move-${STEP.itemId}-${date}`).props.accessibilityRole).toBe('button');
    expect(within(chooser).queryAllByRole('radiogroup')).toHaveLength(0);
    for (const day of RECORDED.days.filter(candidate => candidate.state !== 'proposed' || candidate.date === FIRST.date)) {
      expect(within(chooser).queryByTestId(`week-move-${STEP.itemId}-${day.date}`)).toBeNull();
    }

    await fireEvent.press(within(chooser).getByTestId(`week-move-${STEP.itemId}-${targets[0]!}`));
    expect(lastDecisions()).toEqual({ moves: [{ itemId: STEP.itemId, date: targets[0] }], drops: [] });
    expect(screen.queryByTestId(`week-move-to-${STEP.itemId}`)).toBeNull();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('takes a step off the week without touching the commitment, and puts it back', async () => {
    await show();
    await fireEvent.press(screen.getByTestId(`week-drop-${STEP.itemId}`));
    expect(lastDecisions()).toEqual({ moves: [], drops: [STEP.itemId] });
    expect(mockSave).not.toHaveBeenCalled();

    // The server answers the week with the step off it.
    mockWeek = {
      ...RECORDED,
      days: RECORDED.days.map(day => day.date === FIRST.date ? { ...day, items: [] } : day),
      drops: [{ itemId: STEP.itemId, title: STEP.title }],
    };
    await fireEvent.press(screen.getByTestId(`week-drop-${WITH_STEP[1]!.items[0]!.itemId}`));
    const t = language();
    expect(within(screen.getByTestId('week-dropped')).getByText(t.weekDroppedTitle)).toBeTruthy();
    await fireEvent.press(screen.getByTestId(`week-undrop-${STEP.itemId}`));
    expect(lastDecisions().drops).toEqual([WITH_STEP[1]!.items[0]!.itemId]);
  });
});

describe('the feature\'s name', () => {
  it('is one name per language: the row that opens the screen and the screen say the same thing (M-d)', () => {
    for (const bundle of Object.values(strings)) expect(bundle.xWeekly).toBe(bundle.weekTitle);
  });
});

describe('what the page promises (UAT round 6, #23)', () => {
  /*
   * The week proposes one step a day, and a second only for work due that same
   * day that no earlier day could take (N3; `weekPlan.ts`). Round 6 saw Thursday
   * hold two steps, both due Thursday, under a subtitle that said «خطوة وحدة لكل
   * يوم». The placement was the ruling; the promise was wrong.
   */
  it('names the one exception to a step a day: work due that same day', () => {
    expect(strings.ar.weekBody).toContain('بنفس اليوم');
    expect(strings.en.weekBody).toContain('that same day');
    expect(strings.he.weekBody).toContain('באותו יום');
  });

  it('the row that opens the week does not promise exactly one step a day', () => {
    expect(strings.ar.xWeeklyBody).not.toContain('خطوة وحدة');
    expect(strings.en.xWeeklyBody).not.toMatch(/^One step/);
    expect(strings.he.xWeeklyBody).not.toContain('צעד אחד');
  });
});

describe('the entry point in «اختار شو بدك تعمل»', () => {
  it('is a live row that opens the Week screen, not a Coming-soon section', async () => {
    await show(<ActionModesScreen />);
    const row = screen.getByTestId('mode-weekly');
    expect(row.props.accessibilityRole).toBe('button');
    expect(screen.queryByTestId('product-section-COMING_SOON')).toBeNull();
    await fireEvent.press(row);
    expect(screen.getByTestId('probe-screen').props.children).toBe('weekPlan');
  });
});
