/**
 * «عندي تدريب كل سبت من 10 لـ 4» on the Review card (weekly fixed blocks).
 *
 * Driven in Arabic from the tab bar, on the route's own proposal
 * (`capture.weeklyRange.json`) and its own confirmation
 * (`capture.weeklyBlockConfirmation.json`):
 *
 *   - the card says the block — «تدريب · كل سبت · 10:00–16:00» — and reads
 *     it aloud as words;
 *   - «كل أسبوع» is the default, «مرة وحدة بس» is one tap, and nothing is sent
 *     before the confirm;
 *   - the confirm names the item in `weeklyBlockItemIds` only when weekly;
 *   - Saved shows the block the server made.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { Root } from '../../../Root';
import ar from '../../../i18n/locales/ar.json';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import { stripIsolates } from '../../../i18n/bidi';
import { captureConfirmationSchema, captureProposalSchema } from '../../../api/schemas/capture';
import weeklyRange from '../../../api/__fixtures__/capture.weeklyRange.json';
import weeklyConfirmation from '../../../api/__fixtures__/capture.weeklyBlockConfirmation.json';

import * as captureEndpoints from '../../../api/endpoints/capture';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as analyticsEndpoints from '../../../api/endpoints/analytics';
import * as trustEndpoints from '../../../api/endpoints/trust';
import * as weeklyEndpoints from '../../../api/endpoints/weeklyBlocks';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'ar', languageTag: 'ar-JO', textDirection: 'rtl' }]),
}));

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = {
  uid: 'weekly-review-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};
const ITEM = weeklyRange.items[0]!.itemId;

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;
let confirm: ReturnType<typeof jest.spyOn>;
let create: ReturnType<typeof jest.spyOn>;

beforeEach(async () => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
  jest.spyOn(trustEndpoints, 'getTrust')
    .mockResolvedValue({ success: true, participantId: USER.uid, trust: { analyticsConsent: false } } as never);
  jest.spyOn(analyticsEndpoints, 'recordAnalyticsEvent')
    .mockResolvedValue({ success: true, participantId: USER.uid, recorded: true, eventId: 'e-1' } as never);
  jest.spyOn(weeklyEndpoints, 'listWeeklyBlocks').mockResolvedValue([] as never);
  jest.spyOn(weeklyEndpoints, 'listWeeklyBlockOccurrences').mockResolvedValue([] as never);
  create = jest.spyOn(weeklyEndpoints, 'createWeeklyBlock');
  jest.spyOn(captureEndpoints, 'proposeCapture').mockResolvedValue(captureProposalSchema.parse(weeklyRange) as never);
  confirm = jest.spyOn(captureEndpoints, 'confirmCapture')
    .mockResolvedValue(captureConfirmationSchema.parse(weeklyConfirmation) as never);
});

afterEach(() => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

async function reachReview() {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}><Root /></QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('tab-capture')).not.toBeNull());
  await fireEvent.press(screen.getByTestId('tab-capture'));
  await waitFor(() => expect(screen.queryByTestId('capture-input')).not.toBeNull());
  await fireEvent.changeText(screen.getByTestId('capture-input'), 'عندي تدريب كل سبت من 10 لـ 4');
  await fireEvent.press(screen.getByTestId('capture-analyze'));
  await waitFor(() => expect(screen.queryByTestId(`review-item-${ITEM}`)).not.toBeNull());
}

function textOf(testID: string): string {
  const children = screen.getByTestId(testID).props.children as unknown;
  return stripIsolates(Array.isArray(children) ? children.join('') : String(children));
}

describe('the card', () => {
  it('says the block, weekly by default, and reads it as words', async () => {
    await reachReview();
    // The title on a line of its own, the days and hours under it (u37): one
    // line mixing a Latin title with «كل سبت» wrapped «كل» away from «سبت».
    expect(textOf(`review-weekly-title-${ITEM}`)).toBe('تدريب');
    expect(textOf(`review-weekly-line-${ITEM}`)).toBe('كل سبت · 10:00–16:00');
    expect(screen.getByTestId(`review-weekly-spoken-${ITEM}`).props.accessibilityLabel).toBe('تدريب، كل سبت، من 10:00 لـ 16:00');
    expect(screen.getByTestId(`review-weekly-every-${ITEM}`).props.accessibilityState).toMatchObject({ selected: true });
    expect(screen.getByTestId(`review-weekly-once-${ITEM}`).props.accessibilityState).toMatchObject({ selected: false });
    expect(textOf(`review-weekly-note-${ITEM}`)).toBe(ar.wbReviewWeeklyNote);
    // The one-off's date chip steps aside while it is weekly.
    expect(screen.queryByTestId(`review-when-${ITEM}`)).toBeNull();
    expect(screen.getByTestId(`review-item-${ITEM}`).props.accessibilityLabel).toContain('كل سبت، من 10:00 لـ 16:00');
  });

  it('keeps the radios outside the checkbox, so a screen reader can reach them', async () => {
    await reachReview();
    // A Pressable is one element to VoiceOver/TalkBack: radios inside the
    // card's checkbox could not be focused at all.
    expect(within(screen.getByTestId(`review-item-${ITEM}`)).queryByTestId(`review-weekly-every-${ITEM}`)).toBeNull();
    expect(within(screen.getByTestId(`review-card-${ITEM}`)).queryByTestId(`review-weekly-every-${ITEM}`)).not.toBeNull();
    expect(screen.getByTestId(`review-weekly-every-${ITEM}`).props.accessibilityRole).toBe('radio');
  });

  it('switches to once in one tap, and shows the one-off\'s date again', async () => {
    await reachReview();
    await fireEvent.press(screen.getByTestId(`review-weekly-once-${ITEM}`));
    expect(screen.getByTestId(`review-weekly-once-${ITEM}`).props.accessibilityState).toMatchObject({ selected: true });
    expect(textOf(`review-weekly-note-${ITEM}`)).toBe(ar.wbReviewOnceNote);
    expect(screen.queryByTestId(`review-when-${ITEM}`)).not.toBeNull();
  });

  it('writes nothing before the confirm', async () => {
    await reachReview();
    await fireEvent.press(screen.getByTestId(`review-weekly-once-${ITEM}`));
    await fireEvent.press(screen.getByTestId(`review-weekly-every-${ITEM}`));
    expect(confirm).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('the confirm', () => {
  it('names the item as weekly, and Saved shows the block the server made', async () => {
    await reachReview();
    await fireEvent.press(screen.getByTestId('review-confirm'));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    const sent = confirm.mock.calls[0]![0] as { itemIds: string[]; weeklyBlockItemIds?: string[] };
    expect(sent.itemIds).toEqual([ITEM]);
    expect(sent.weeklyBlockItemIds).toEqual([ITEM]);
    const block = weeklyConfirmation.weeklyBlocks[0]!.block;
    await waitFor(() => expect(screen.queryByTestId(`saved-weekly-${block.id}`)).not.toBeNull());
    expect(textOf(`saved-weekly-when-${block.id}`)).toBe('كل سبت · 10:00–16:00');
    // A block is not a commitment Undo could take back.
    expect(screen.queryByTestId('saved-undo')).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('keeps it a one-off when the person said so', async () => {
    await reachReview();
    await fireEvent.press(screen.getByTestId(`review-weekly-once-${ITEM}`));
    await fireEvent.press(screen.getByTestId('review-confirm'));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    const sent = confirm.mock.calls[0]![0] as { itemIds: string[]; weeklyBlockItemIds?: string[] };
    expect(sent.itemIds).toEqual([ITEM]);
    expect(sent.weeklyBlockItemIds ?? []).toEqual([]);
  });
});
