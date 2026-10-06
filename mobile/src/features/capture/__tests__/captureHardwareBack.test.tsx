/**
 * Android's hardware back on the capture page is the header's back
 * (UAT 2026-09-30, u57–u60).
 *
 * The header ✕ asked «كمّل كتابة / تجاهلها» before dropping a typed draft;
 * the hardware back went to Root's history walk, which closed the capture task
 * and threw the draft away without a word. Driven through the real Root, with
 * BackHandler's dispatch reproduced: the newest listener first, and the first
 * one that returns true ends it.
 */
import React from 'react';
import { BackHandler } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { Root } from '../../../Root';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import * as captureEndpoints from '../../../api/endpoints/capture';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as trustEndpoints from '../../../api/endpoints/trust';
import { chatServer } from '../../../testing/captureChat';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = {
  uid: 'chat-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};
const SOON = new Date(Date.now() + 6 * 3_600_000).toISOString();
const SENTENCE = 'Hand in the report tomorrow at 6, and call Sami';

function proposal() {
  return {
    version: 'v1',
    proposalId: 'p-1',
    status: 'proposed',
    items: [
      { itemId: 'i-1', title: 'Hand in the report', resolvedTime: SOON, needsClarification: false, priority: 'normal' },
      { itemId: 'i-2', title: 'Call Sami', resolvedTime: null, needsClarification: false },
    ],
    provenance: { requestedEngine: 'rules', executedEngine: 'rule-based', fallbackUsed: false },
  };
}

let client: QueryClient;
let backHandlers: (() => boolean | null | undefined)[] = [];
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(async () => {
  onlineManager.setOnline(true);
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
  jest.spyOn(trustEndpoints, 'getTrust')
    .mockResolvedValue({ success: true, participantId: 'chat-user', trust: { analyticsConsent: false } } as never);
  jest.spyOn(captureEndpoints, 'chatCapture').mockImplementation(chatServer(() => (proposal())) as never);
  backHandlers = [];
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation(((_name: string, handler: () => boolean) => {
    backHandlers.push(handler);
    return { remove: () => { backHandlers = backHandlers.filter((h) => h !== handler); } };
  }) as never);
});

afterEach(async () => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  await AsyncStorage.removeItem(LANGUAGE_STORAGE_KEY);
});

async function openCapture() {
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
}

async function analyze(text = SENTENCE) {
  await fireEvent.changeText(screen.getByTestId('capture-input'), text);
  await fireEvent.press(screen.getByTestId('capture-analyze'));
  await waitFor(() => expect(screen.queryByTestId('review-item-i-1')).not.toBeNull());
}

const field = () => screen.getByTestId('capture-input').props.value as string;


/** What React Native does with a back press. Returns whether the app kept it. */
async function pressHardwareBack(): Promise<boolean> {
  let handled = false;
  await React.act(async () => {
    for (const handler of [...backHandlers].reverse()) {
      if (handler()) { handled = true; break; }
    }
  });
  return handled;
}

describe('hardware back on the capture page', () => {
  // M2b (audit condition 9): Back closes capture and keeps the draft for when
  // «احكيها» opens again — no question, because nothing is thrown away.
  it('with a typed draft, closes capture and keeps the draft for later', async () => {
    await openCapture();
    await fireEvent.changeText(screen.getByTestId('capture-input'), SENTENCE);
    expect(await pressHardwareBack()).toBe(true);
    await waitFor(() => expect(screen.queryByTestId('capture-input')).toBeNull());
    expect(screen.queryByTestId('capture-discard')).toBeNull();
    await fireEvent.press(screen.getByTestId('tab-capture'));
    await waitFor(() => expect(screen.queryByTestId('capture-input')).not.toBeNull());
    expect(field()).toBe(SENTENCE);
  });

  it('with an empty draft, closes capture', async () => {
    await openCapture();
    expect(await pressHardwareBack()).toBe(true);
    await waitFor(() => expect(screen.queryByTestId('capture-input')).toBeNull());
    expect(screen.queryByTestId('capture-discard')).toBeNull();
  });

  it('in review, goes back to the composer with the sentence, like the header Back', async () => {
    await openCapture();
    await analyze();
    expect(await pressHardwareBack()).toBe(true);
    await waitFor(() => expect(screen.queryByTestId('review-item-i-1')).toBeNull());
    expect(field()).toBe(SENTENCE);
    expect(screen.getByTestId('capture-cancel')).toBeTruthy();
  });

  it('after a save in the chat, closes capture: nothing is left unsaved to ask about (owner request 2026-09-30)', async () => {
    jest.spyOn(captureEndpoints, 'confirmCapture').mockResolvedValue({
      success: true, replayed: false, failed: [],
      persisted: [{ itemId: 'i-1', commitmentId: 'c-1', title: 'Hand in the report', resolvedTime: SOON }],
    } as never);
    await openCapture();
    await analyze();
    await fireEvent.press(screen.getByTestId('review-confirm'));
    await waitFor(() => expect(screen.queryByTestId('chat-saved-1')).not.toBeNull());
    expect(await pressHardwareBack()).toBe(true);
    await waitFor(() => expect(screen.queryByTestId('capture-input')).toBeNull());
    expect(screen.queryByTestId('capture-discard')).toBeNull();
  });
});
