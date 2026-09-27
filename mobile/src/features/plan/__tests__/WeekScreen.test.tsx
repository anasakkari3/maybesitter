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
afterEach(() => {
  cleanup();
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
    const reasonKey = { due: 'weekReasonDue', carried: 'weekReasonCarried', open: 'weekReasonOpen', moved: 'weekReasonMoved' } as const;
    expect(within(row).getByText(t[reasonKey[STEP.reason!]])).toBeTruthy();
    expect(within(row).getAllByLabelText(new RegExp(STEP.title!)).length).toBeGreaterThan(0);
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
    const free = RECORDED.days.find(day => day.items.length === 0 && day.fixed.length === 0)!;
    expect(screen.getByTestId(`week-free-${free.date}`).props.children).toBe(t.weekFreeDay);
    expect(screen.queryByTestId(`week-save-${free.date}`)).toBeNull();
  });

  it('says so when there is nothing to place this week', async () => {
    mockWeek = { ...RECORDED, days: RECORDED.days.map(day => ({ ...day, state: 'proposed' as const, items: [], fixed: [], unplaced: [] })), drops: [], waiting: 0 };
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
