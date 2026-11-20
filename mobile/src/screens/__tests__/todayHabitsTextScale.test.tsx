/**
 * Today's habit rows at large text (simulator 2026-11-20, sim-1120 shots
 * 02b–02f and 02x).
 *
 * A — the time line «07:00–09:00 · 30 دقيقة» was one paragraph, and at AX5 it
 *     drew «07:» and «30 دقيقة» with the rest of the hour gone: the paragraph
 *     wrapped through the hour's left-to-right isolate. The hour is now its
 *     own paragraph, the minutes another, and the two wrap as whole pieces.
 * B — after «تمّت», «تراجع» sat beside the words and squeezed them to a third
 *     of the row, so the title broke inside its words («أمش / ي»). From the
 *     large layout mode up the row stacks: the circle and the words on one
 *     line, «تراجع» under them at full width.
 * C — a text-size change made while Today was open left the block's text as
 *     scattered dots until a relaunch (shot 02x): the same stale paragraph
 *     measurement `RemeasureOnTextScale` exists for. The words are said by
 *     views that stay; the drawn paragraphs are replaced on each change.
 *
 * Real `useWindowDimensions` and `Dimensions.set` (jest.setup pins the scale
 * to 1; RN's own mock would say 2), as in todayLiveTextScale.test.
 */
import React from 'react';
import { Dimensions, StyleSheet } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../api/auth';
import type { AuthUser } from '../../auth/types';
import { TodayScreen } from '../TodayScreen';
import en from '../../i18n/locales/en.json';
import { formatClockRange } from '../../i18n/format';
import consentsFixture from '../../api/__fixtures__/consents.answered.json';
import profileFixture from '../../api/__fixtures__/profile.one.json';
import * as commitmentEndpoints from '../../api/endpoints/commitments';
import * as nextStepEndpoints from '../../api/endpoints/nextStep';
import * as consentEndpoints from '../../api/endpoints/consents';
import * as planEndpoints from '../../api/endpoints/plans';
import * as profileEndpoints from '../../api/endpoints/profile';
import * as weeklyEndpoints from '../../api/endpoints/weeklyBlocks';
import * as habitEndpoints from '../../api/endpoints/habits';
import type { Habit, HabitOccurrence } from '../../api/schemas/habits';

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () =>
  jest.requireActual('react-native/Libraries/Utilities/useWindowDimensions'),
);
jest.mock('../../i18n/timezone', () => ({
  ...(jest.requireActual('../../i18n/timezone') as object),
  useTimeZone: () => 'Asia/Jerusalem',
}));

const AX5 = 3.12;
const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const USER: AuthUser = { uid: 'today-habits-scale-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'] };
const DAY = '2026-11-20';

function setFontScale(fontScale: number) {
  const window = { width: 390, height: 844, scale: 3, fontScale };
  Dimensions.set({ window, screen: window });
}

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
const occurrence = (habitId: string, state: HabitOccurrence['state']): HabitOccurrence => ({
  occurrenceId: `${habitId}.${DAY}.0`, habitId, localDate: DAY, ordinal: 0, state, durationMinutes: 30, recoveredFromOccurrenceId: null,
});

// Walk is done (so «تراجع» is drawn) and has an hour; Read is open with none.
const WALK = habit('walk', 'Walk for half an hour', { preferredWindows: [{ start: '07:00', end: '09:00' }] });
const READ = habit('read', 'Read');

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(() => {
  setFontScale(1);
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
  jest.spyOn(habitEndpoints, 'listHabits').mockResolvedValue([WALK, READ]);
  jest.spyOn(habitEndpoints, 'listHabitsToday').mockResolvedValue({
    localDate: DAY, occurrences: [occurrence('walk', 'completed'), occurrence('read', 'pending')], anyDay: [], weeks: [],
  });
});

afterEach(async () => {
  await cleanup();
  await new Promise(resolve => setTimeout(resolve, 0));
  setFontScale(1);
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

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
  await waitFor(() => expect(screen.queryByTestId('today-habit-undo-walk')).not.toBeNull());
}

type Style = Record<string, unknown>;
const flat = (id: string) => (StyleSheet.flatten(screen.getByTestId(id).props.style) ?? {}) as Style;
/** Every drawn paragraph inside the node, the ones a wrapper hides from a screen reader too. */
const drawnIn = (id: string) => within(screen.getByTestId(id)).getAllByText(/./, { includeHiddenElements: true });
const textOf = (id: string) => {
  const children = screen.getByTestId(id).props.children as unknown;
  return Array.isArray(children) ? children.join('') : String(children);
};

describe('Today\'s habits at large text', () => {
  it('A: the hour is a paragraph of its own and the minutes another, so the hour never wraps through its isolate', async () => {
    setFontScale(AX5);
    await show();
    expect(textOf('today-habit-time-walk')).toBe(formatClockRange('07:00', '09:00'));
    expect(textOf('today-habit-minutes-walk')).toBe(`· ${'30 min'}`);
    // No paragraph in the row holds the hour together with anything else.
    for (const node of drawnIn('today-habit-walk')) {
      const text = Array.isArray(node.props.children) ? node.props.children.join('') : String(node.props.children);
      if (text.includes('07:00')) expect(text).toBe(formatClockRange('07:00', '09:00'));
    }
    // The two pieces sit in a row that wraps whole pieces, said as one line.
    expect(flat('today-habit-detail-walk')).toEqual(expect.objectContaining({ flexDirection: 'row', flexWrap: 'wrap' }));
    expect(screen.getByTestId('today-habit-detail-walk').props.accessibilityLabel)
      .toBe(`${formatClockRange('07:00', '09:00')} · ${'30 min'}`);
    // A habit with no hour has only its minutes.
    expect(textOf('today-habit-minutes-read')).toBe('30 min');
    expect(screen.queryByTestId('today-habit-time-read')).toBeNull();
  });

  it('B: from the large mode up «تراجع» goes under the words at full width; at the default size it stays beside them', async () => {
    await show();
    // Default size: one row, the words take the room «تراجع» leaves.
    expect(flat('today-habit-walk').flexDirection).toBe('row');
    expect(flat('today-habit-undo-walk').alignSelf).toBeUndefined();
    await act(async () => { setFontScale(AX5); });
    // AX5: a column — the circle and the words, then «تراجع» across the row.
    expect(flat('today-habit-walk').flexDirection ?? 'column').toBe('column');
    expect(flat('today-habit-undo-walk').alignSelf).toBe('stretch');
    const row = screen.getByTestId('today-habit-walk');
    const main = screen.getByTestId('today-habit-main-walk');
    expect(within(row).getByTestId('today-habit-main-walk')).toBe(main);
    // «تراجع» is not inside the line that holds the words.
    expect(within(main).queryByTestId('today-habit-undo-walk')).toBeNull();
    expect(within(main).getByTestId('today-habit-title-walk')).toBeTruthy();
    // Back at the default size it commits what a fresh open commits, and the
    // line whose parent changes direction never carries a flex basis (fillRow).
    const ax5Main = flat('today-habit-main-walk');
    await act(async () => { setFontScale(1); });
    expect(flat('today-habit-walk').flexDirection).toBe('row');
    for (const style of [ax5Main, flat('today-habit-main-walk')]) {
      expect(style.flex).toBeUndefined();
      expect(style.flexBasis).toBeUndefined();
    }
    // «تراجع» keeps one parent in both modes, so it is never remounted (focus stays).
  });

  it('B: «تراجع» is the same element across a live change, and 44 points to press in both modes', async () => {
    await show();
    const undo = screen.getByTestId('today-habit-undo-walk');
    const circle = screen.getByTestId('today-habit-done-read');
    await act(async () => { setFontScale(AX5); });
    expect(screen.getByTestId('today-habit-undo-walk')).toBe(undo);
    expect(screen.getByTestId('today-habit-done-read')).toBe(circle);
    expect(Number(flat('today-habit-undo-walk').minHeight)).toBeGreaterThanOrEqual(44);
    expect(flat('today-habit-done-read')).toEqual(expect.objectContaining({ minWidth: 44, minHeight: 44 }));
  });

  it('C: the block\'s words are said by views that stay, and each drawn paragraph is new after each change', async () => {
    await show();
    const said = ['today-habits-title', 'today-habit-title-said-walk', 'today-habit-detail-walk', 'today-habit-decided-walk',
      'today-habit-title-said-read', 'today-habit-detail-read'];
    for (const id of said) {
      const node = screen.getByTestId(id);
      expect(node.props.accessible).toBe(true);
      expect(String(node.props.accessibilityLabel).length).toBeGreaterThan(0);
      for (const text of drawnIn(id)) expect(text.props.accessible).toBe(false);
    }
    expect(screen.getByTestId('today-habits-title').props.accessibilityRole).toBe('header');
    expect(screen.getByTestId('today-habit-title-said-walk').props.accessibilityLabel).toBe(WALK.title);
    expect(screen.getByTestId('today-habit-decided-walk').props.accessibilityLabel).toBe(en.xHabitTodayDone);
    const kept = [...said, 'today-habit-undo-walk', 'today-habit-done-read', 'today-habit-live-walk'].map(id => screen.getByTestId(id));
    let drawn = said.flatMap(drawnIn);
    for (const scale of [AX5, 1]) {
      await act(async () => { setFontScale(scale); });
      const next = said.flatMap(drawnIn);
      expect(next).toHaveLength(drawn.length);
      for (const node of next) expect(drawn).not.toContain(node);
      [...said, 'today-habit-undo-walk', 'today-habit-done-read', 'today-habit-live-walk']
        .forEach((id, i) => expect(screen.getByTestId(id)).toBe(kept[i]));
      drawn = next;
    }
  });
});
