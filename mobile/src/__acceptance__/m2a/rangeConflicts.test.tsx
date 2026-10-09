/** M2a · Task A · M2-A-R3-002 — ranged items conflict as intervals on both card renderers. */
import React, { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClientProvider } from '@tanstack/react-query';
import { AppProvider } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { CaptureProvider, useCaptureFlow } from '../../features/capture/CaptureProvider';
import { ReviewScreen } from '../../screens/ReviewScreen';
import type { CaptureProposal } from '../../api/schemas/capture';
import type { CaptureItemEdit } from '../../features/capture/captureMachine';
import * as captureEndpoints from '../../api/endpoints/capture';
import { resetAuthForTests } from '../../api/auth';
import { seedDeviceBusyCache } from '../../testing/deviceBusyCache';
import { resetBusySyncForTests } from '../../features/calendar/useBusyCalendar';
import { chatServer } from '../../testing/captureChat';
import { METRICS, openCapture, prepareRoot, say, type RootHarness } from './harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'UTC' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

type Busy = { nativeId: string; startAt: string; endAt: string; allDay: boolean };

function proposal(start: string, end: string): CaptureProposal {
  return {
    version: 'v1', proposalId: `range-${start}`, status: 'proposed', seeds: [],
    items: [{ itemId: 'range-item', title: 'Workshop', resolvedTime: start, endTime: end, needsClarification: false }],
  };
}

function Mount({ start, edit }: { start: CaptureProposal; edit?: CaptureItemEdit }) {
  const { adoptProposal, editItem } = useCaptureFlow();
  useEffect(() => {
    adoptProposal(start, 'tab');
    if (edit) editItem('range-item', edit);
  }, [adoptProposal, edit, editItem, start]);
  return <ReviewScreen />;
}

let harness: RootHarness;

beforeEach(async () => {
  resetBusySyncForTests();
  harness = await prepareRoot('en');
});

afterEach(async () => {
  await cleanup();
  harness.client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});

async function cacheBusy(block: Busy): Promise<void> {
  // The cache is the signed-in account's own (M4a, M4A-R8-001).
  await seedDeviceBusyCache('m2a-acceptance-user', [block]);
}

async function showReview(start: CaptureProposal, block: Busy, edit?: CaptureItemEdit): Promise<boolean> {
  await cacheBusy(block);
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <QueryClientProvider client={harness.client}>
        <AuthProvider repository={harness.repository} isDevBundle={false}>
          <AppProvider><CaptureProvider><Mount start={start} {...(edit ? { edit } : {})} /></CaptureProvider></AppProvider>
        </AuthProvider>
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('review-item-range-item')).not.toBeNull());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  return screen.queryByTestId('review-busy-range-item') !== null;
}

describe('interval overlap', () => {
  it('A3 ranged conflicts: chat card and Review tools both notice a busy interval inside the proposal range', async () => {
    const start = '2030-01-07T16:00:00.000Z';
    const end = '2030-01-07T20:00:00.000Z';
    await cacheBusy({ nativeId: 'inside', startAt: '2030-01-07T18:00:00.000Z', endAt: '2030-01-07T19:00:00.000Z', allDay: false });
    jest.spyOn(captureEndpoints, 'chatCapture').mockImplementation(chatServer(() => proposal(start, end)) as never);
    await openCapture(harness);
    await say('Workshop from four until eight');
    await waitFor(() => expect(screen.queryByTestId('review-item-range-item')).not.toBeNull());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    const chatHasConflict = screen.queryByTestId('review-busy-range-item') !== null;

    await act(async () => { await fireEvent.press(screen.getByTestId('review-tools')); });
    await waitFor(() => expect(screen.queryByTestId('review-scroll')).not.toBeNull());
    const reviewHasConflict = screen.queryByTestId('review-busy-range-item') !== null;
    expect([chatHasConflict, reviewHasConflict]).toEqual([true, true]);
  });

  it('A3 ranged conflicts: interior, boundary-touch, overnight, cleared, and moved ranges follow half-open interval overlap', async () => {
    const cases: { start: CaptureProposal; busy: Busy; edit?: CaptureItemEdit }[] = [
      {
        start: proposal('2030-01-07T16:00:00.000Z', '2030-01-07T20:00:00.000Z'),
        busy: { nativeId: 'inside', startAt: '2030-01-07T18:00:00.000Z', endAt: '2030-01-07T19:00:00.000Z', allDay: false },
      },
      {
        start: proposal('2030-01-07T16:00:00.000Z', '2030-01-07T20:00:00.000Z'),
        busy: { nativeId: 'touch', startAt: '2030-01-07T20:00:00.000Z', endAt: '2030-01-07T21:00:00.000Z', allDay: false },
      },
      {
        start: proposal('2030-01-07T23:00:00.000Z', '2030-01-08T02:00:00.000Z'),
        busy: { nativeId: 'overnight', startAt: '2030-01-08T01:00:00.000Z', endAt: '2030-01-08T01:30:00.000Z', allDay: false },
      },
      {
        start: proposal('2030-01-07T16:00:00.000Z', '2030-01-07T20:00:00.000Z'),
        busy: { nativeId: 'cleared', startAt: '2030-01-07T18:00:00.000Z', endAt: '2030-01-07T19:00:00.000Z', allDay: false },
        edit: { localDateTime: '' },
      },
      {
        start: proposal('2030-01-07T16:00:00.000Z', '2030-01-07T20:00:00.000Z'),
        busy: { nativeId: 'moved', startAt: '2030-01-08T23:00:00.000Z', endAt: '2030-01-08T23:30:00.000Z', allDay: false },
        edit: { localDateTime: '2030-01-08T20:00' },
      },
    ];
    const found: boolean[] = [];
    for (const entry of cases) {
      found.push(await showReview(entry.start, entry.busy, entry.edit));
      await cleanup();
      harness.client.clear();
    }
    expect(found).toEqual([true, false, true, false, true]);
  });
});
