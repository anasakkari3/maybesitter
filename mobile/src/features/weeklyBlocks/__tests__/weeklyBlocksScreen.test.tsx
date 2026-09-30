/**
 * Settings → «الثابت الأسبوعي», in Arabic, on the route's own list fixture.
 *
 * RNTL v14: `render()` and every event are awaited.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import ar from '../../../i18n/locales/ar.json';
import { stripIsolates } from '../../../i18n/bidi';
import { WeeklyBlockRefusedError } from '../../../api/errors';
import { weeklyBlockListSchema, type WeeklyBlock } from '../../../api/schemas/weeklyBlocks';
import listFixture from '../../../api/__fixtures__/weeklyBlocks.list.json';
import * as endpoints from '../../../api/endpoints/weeklyBlocks';
import { WeeklyBlocksScreen } from '../WeeklyBlocksScreen';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'ar', languageTag: 'ar-JO', textDirection: 'rtl' }]),
}));

const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const USER: AuthUser = { uid: 'weekly-settings-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'] };
const BLOCKS: WeeklyBlock[] = weeklyBlockListSchema.parse(listFixture).items;
const [TRAINING, WORK] = BLOCKS as [WeeklyBlock, WeeklyBlock];

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(() => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
});

afterEach(async () => {
  await cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

async function show() {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}><WeeklyBlocksScreen onBack={() => {}} /></QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

function textOf(testID: string): string {
  const children = screen.getByTestId(testID).props.children as unknown;
  return stripIsolates(Array.isArray(children) ? children.join('') : String(children));
}

describe('the list', () => {
  it('shows each block with its days and hours, read aloud as words', async () => {
    jest.spyOn(endpoints, 'listWeeklyBlocks').mockResolvedValue(BLOCKS);
    await show();
    await waitFor(() => expect(screen.queryByTestId(`weekly-block-${TRAINING.id}`)).not.toBeNull());
    expect(textOf(`weekly-block-when-${TRAINING.id}`)).toBe('كل سبت · 10:00–16:00');
    expect(textOf(`weekly-block-when-${WORK.id}`)).toBe('كل يوم · 10:00–16:00');
    expect(screen.getByTestId(`weekly-block-open-${TRAINING.id}`).props.accessibilityLabel).toBe('تدريب، كل سبت، من 10:00 لـ 16:00');
    expect(screen.getByTestId(`weekly-block-active-${TRAINING.id}`).props.accessibilityLabel).toBe(`${ar.wbActiveToggle}، تدريب`);
  });

  it('says so honestly when there are none', async () => {
    jest.spyOn(endpoints, 'listWeeklyBlocks').mockResolvedValue([]);
    await show();
    expect(await screen.findByTestId('weekly-blocks-empty')).toBeTruthy();
    expect(screen.getByText(ar.wbEmptyTitle)).toBeTruthy();
  });

  it('pauses with the switch, and shows what the server answered', async () => {
    const list = jest.spyOn(endpoints, 'listWeeklyBlocks').mockResolvedValueOnce(BLOCKS);
    const paused = { ...TRAINING, status: 'paused' as const, deviceEvent: null };
    const patch = jest.spyOn(endpoints, 'patchWeeklyBlock').mockResolvedValue(paused);
    list.mockResolvedValue([paused, WORK]);
    await show();
    await waitFor(() => expect(screen.queryByTestId(`weekly-block-active-${TRAINING.id}`)).not.toBeNull());
    await fireEvent(screen.getByTestId(`weekly-block-active-${TRAINING.id}`), 'valueChange', false);
    await waitFor(() => expect(patch).toHaveBeenCalledWith(TRAINING.id, { status: 'paused' }));
    await waitFor(() => expect(screen.queryByTestId(`weekly-block-paused-${TRAINING.id}`)).not.toBeNull());
  });
});

describe('editing', () => {
  it('sends only what changed', async () => {
    jest.spyOn(endpoints, 'listWeeklyBlocks').mockResolvedValue(BLOCKS);
    const patch = jest.spyOn(endpoints, 'patchWeeklyBlock').mockResolvedValue(TRAINING);
    await show();
    await waitFor(() => expect(screen.queryByTestId(`weekly-block-open-${TRAINING.id}`)).not.toBeNull());
    await fireEvent.press(screen.getByTestId(`weekly-block-open-${TRAINING.id}`));
    await fireEvent.press(screen.getByTestId('weekly-edit-day-0'));
    await fireEvent.press(screen.getByTestId('weekly-edit-save'));
    await waitFor(() => expect(patch).toHaveBeenCalledWith(TRAINING.id, { weekdays: [0, 6] }));
    // Back on the list.
    await waitFor(() => expect(screen.queryByTestId('weekly-edit')).toBeNull());
  });

  it('refuses an end before the start before sending, and says the server\'s refusal the same way', async () => {
    jest.spyOn(endpoints, 'listWeeklyBlocks').mockResolvedValue(BLOCKS);
    const patch = jest.spyOn(endpoints, 'patchWeeklyBlock').mockRejectedValue(new WeeklyBlockRefusedError('overnight_not_supported'));
    await show();
    await waitFor(() => expect(screen.queryByTestId(`weekly-block-open-${TRAINING.id}`)).not.toBeNull());
    await fireEvent.press(screen.getByTestId(`weekly-block-open-${TRAINING.id}`));
    await fireEvent.press(screen.getByTestId('weekly-edit-end'));
    // 16:00 → 08:00 on the wheel.
    const picker = screen.getByTestId('weekly-edit-picker');
    await fireEvent(picker, 'change', { type: 'set', nativeEvent: { timestamp: new Date(2026, 0, 1, 8, 0).getTime(), utcOffset: 0 } }, new Date(2026, 0, 1, 8, 0));
    expect(textOf('weekly-edit-end-value')).toBe('08:00');
    await fireEvent.press(screen.getByTestId('weekly-edit-save'));
    expect(textOf('weekly-edit-error')).toBe(ar.wbErrOvernight);
    expect(patch).not.toHaveBeenCalled();

    // A server with a stricter rule than this form: its code, in Arabic.
    // The wheel stays open on iOS and closes after a pick on Android.
    if (!screen.queryByTestId('weekly-edit-picker')) await fireEvent.press(screen.getByTestId('weekly-edit-end'));
    await fireEvent(screen.getByTestId('weekly-edit-picker'), 'change', { type: 'set', nativeEvent: { timestamp: new Date(2026, 0, 1, 18, 0).getTime(), utcOffset: 0 } }, new Date(2026, 0, 1, 18, 0));
    await fireEvent.press(screen.getByTestId('weekly-edit-save'));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(textOf('weekly-edit-error')).toBe(ar.wbErrOvernight));
  });

  it('deletes only after the confirmation dialog', async () => {
    jest.spyOn(endpoints, 'listWeeklyBlocks').mockResolvedValue(BLOCKS);
    const remove = jest.spyOn(endpoints, 'deleteWeeklyBlock').mockResolvedValue(undefined);
    await show();
    await waitFor(() => expect(screen.queryByTestId(`weekly-block-open-${TRAINING.id}`)).not.toBeNull());
    await fireEvent.press(screen.getByTestId(`weekly-block-open-${TRAINING.id}`));
    await fireEvent.press(screen.getByTestId('weekly-edit-delete'));
    expect(screen.getByTestId('weekly-delete-dialog')).toBeTruthy();
    expect(remove).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('weekly-delete-cancel'));
    expect(screen.queryByTestId('weekly-delete-dialog')).toBeNull();
    expect(remove).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('weekly-edit-delete'));
    await fireEvent.press(screen.getByTestId('weekly-delete-confirm'));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(TRAINING.id));
  });
});

describe('adding one by hand', () => {
  it('creates it only on the explicit save, with the moment of that press as the confirmation', async () => {
    jest.spyOn(endpoints, 'listWeeklyBlocks').mockResolvedValue([]);
    const create = jest.spyOn(endpoints, 'createWeeklyBlock').mockResolvedValue(TRAINING);
    await show();
    await fireEvent.press(await screen.findByTestId('weekly-blocks-add'));
    await fireEvent.changeText(screen.getByTestId('weekly-edit-title'), 'دوام');
    for (const day of [0, 1, 2, 3, 4]) await fireEvent.press(screen.getByTestId(`weekly-edit-day-${day}`));
    expect(textOf('weekly-edit-preview-title')).toBe('دوام');
    expect(textOf('weekly-edit-preview')).toBe('من الأحد للخميس · 09:00–17:00');
    expect(create).not.toHaveBeenCalled();
    const before = Date.now();
    await fireEvent.press(screen.getByTestId('weekly-edit-save'));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const sent = create.mock.calls[0]![0];
    expect(sent).toMatchObject({ title: 'دوام', weekdays: [0, 1, 2, 3, 4], start: '09:00', end: '17:00', timezone: 'Asia/Jerusalem' });
    expect(Date.parse(sent.confirmedByUserAt)).toBeGreaterThanOrEqual(before - 1000);
  });

  it('asks for a name and a day rather than sending an empty block', async () => {
    jest.spyOn(endpoints, 'listWeeklyBlocks').mockResolvedValue([]);
    const create = jest.spyOn(endpoints, 'createWeeklyBlock');
    await show();
    await fireEvent.press(await screen.findByTestId('weekly-blocks-add'));
    await fireEvent.press(screen.getByTestId('weekly-edit-save'));
    expect(textOf('weekly-edit-error')).toBe(ar.wbErrNoTitle);
    await fireEvent.changeText(screen.getByTestId('weekly-edit-title'), 'x');
    await fireEvent.press(screen.getByTestId('weekly-edit-save'));
    expect(textOf('weekly-edit-error')).toBe(ar.wbErrNoDay);
    expect(create).not.toHaveBeenCalled();
  });
});
