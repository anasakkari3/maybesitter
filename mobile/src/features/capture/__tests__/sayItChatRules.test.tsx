/**
 * The Say-it chat page keeps the capture rules the old composer kept.
 *
 * The chat page arrived from a picture, and the picture drew controls the
 * product does not have or must not offer: a commute question under every
 * multi-item proposal (there is no commute feature), one-tap "Tomorrow only"
 * and "Make it a must" chips that rewrote every selected item at once, example
 * chips that overwrote a typed draft, an "AI assistant · online" subtitle when
 * the AI was off, and a header Back that threw the sentence away. Each case
 * below is one of those, driven from the tab bar through the real provider.
 */
import React from 'react';
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
import en from '../../../i18n/locales/en.json';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import * as captureEndpoints from '../../../api/endpoints/capture';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as trustEndpoints from '../../../api/endpoints/trust';
import * as consentEndpoints from '../../../api/endpoints/consents';
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

describe('review offers only what the product does', () => {
  it('a multi-item proposal asks no commute question and offers no commute, tomorrow-only or must chip', async () => {
    await openCapture();
    await analyze();
    expect(screen.queryByTestId('chat-followup')).toBeNull();
    expect(screen.queryByText('Do you want me to block commute time between these?')).toBeNull();
    for (const id of ['commute', 'tomorrow', 'must']) expect(screen.queryByTestId(`chat-quick-${id}`)).toBeNull();
    expect(screen.queryByTestId('chat-quick-actions')).toBeNull();
    for (const label of ['Add commute time', 'Tomorrow only', 'Make it a must']) expect(screen.queryByText(label)).toBeNull();
  });

  // The save's words follow the selection (Stitch 03): «احفظ الاتنين», then
  // «احفظ وحدة», and nothing to press when nothing is ticked.
  it('the save button counts what it will save, in its text and its label', async () => {
    await openCapture();
    await analyze();
    const confirm = screen.getByTestId('review-confirm');
    expect(confirm.props.accessibilityLabel).toBe('Save both');
    expect(screen.getByText('Save both')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('review-item-i-2'));
    await waitFor(() => expect(screen.getByTestId('review-confirm').props.accessibilityLabel).toBe('Save it'));
    expect(screen.getByTestId('review-item-i-2').props.accessibilityState.checked).toBe(false);
    expect(screen.queryByText(en.chatNotIncluded)).toBeNull();
    await fireEvent.press(screen.getByTestId('review-item-i-1'));
    await waitFor(() => expect(screen.getByTestId('review-confirm').props.accessibilityLabel).toBe('Nothing to save'));
    expect(screen.getByTestId('review-confirm').props.accessibilityState.disabled).toBe(true);
  });
});

/*
 * M2b (audit condition 9, review M2B-A-005): in the chat, Back from the cards
 * closes capture and keeps the conversation and the person's choices for when
 * «احكيها» opens again, even with no summary (an older server). «إلغاء الكل»
 * is the way to throw it away, and it asks first.
 */
describe('the header Back in a chat review closes capture and keeps it', () => {
  it('an untouched proposal: Back closes without asking, and the cards are there again on reopening', async () => {
    await openCapture();
    await analyze();
    expect(screen.getByTestId('review-back').props.accessibilityLabel).toBe(en.back);
    await fireEvent.press(screen.getByTestId('review-back'));
    await waitFor(() => expect(screen.queryByTestId('review-item-i-1')).toBeNull());
    expect(screen.queryByTestId('capture-discard')).toBeNull();
    await fireEvent.press(screen.getByTestId('tab-capture'));
    await waitFor(() => expect(screen.queryByTestId('review-item-i-1')).not.toBeNull());
  });

  it('a touched proposal: Back keeps the change too', async () => {
    await openCapture();
    await analyze();
    await fireEvent.press(screen.getByTestId('review-item-i-2'));
    await fireEvent.press(screen.getByTestId('review-back'));
    await waitFor(() => expect(screen.queryByTestId('review-item-i-1')).toBeNull());
    expect(screen.queryByTestId('capture-discard')).toBeNull();
    await fireEvent.press(screen.getByTestId('tab-capture'));
    await waitFor(() => expect(screen.queryByTestId('review-item-i-1')).not.toBeNull());
    expect(screen.getByTestId('review-item-i-2').props.accessibilityState.checked).toBe(false);
  });

  it('"Cancel all" is the explicit exit: it asks first, and then it does leave capture', async () => {
    await openCapture();
    await analyze();
    await fireEvent.press(screen.getByTestId('review-cancel'));
    await waitFor(() => expect(screen.queryByTestId('capture-discard')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('capture-discard-confirm'));
    await waitFor(() => expect(screen.queryByTestId('capture-input')).toBeNull());
    expect(screen.queryByTestId('review-item-i-1')).toBeNull();
  });
});

describe('composer example chips', () => {
  it('show only while the draft is empty, so they can never overwrite typed text', async () => {
    await openCapture();
    expect(screen.getAllByTestId(/^chat-quick-example-/)).toHaveLength(3);
    await fireEvent.changeText(screen.getByTestId('capture-input'), 'call Dana');
    expect(screen.queryAllByTestId(/^chat-quick-example-/)).toHaveLength(0);
    expect(field()).toBe('call Dana');
    await fireEvent.changeText(screen.getByTestId('capture-input'), '');
    expect(screen.getAllByTestId(/^chat-quick-example-/)).toHaveLength(3);
  });
});

describe('the header claims only what is true', () => {
  // AI processing can no longer be turned off (owner decision 2026-09-30):
  // an account whose old record still says "declined" is read as granted by
  // the server, and the page has no AI-off chip, no rules hint and no way to
  // decline — it tells the person instead, before the first message.
  it('AI is always on: the subtitle, the disclosure before any message, and no AI-off chip or menu hint', async () => {
    jest.spyOn(consentEndpoints, 'getConsents').mockResolvedValue({
      aiProcessing: { state: 'declined', asked: true },
      recommendations: { state: 'declined', asked: true },
      currentVersions: { aiProcessing: 'ai-consent-v1', recommendations: 'rec-consent-v1' },
    } as never);
    await openCapture();
    expect(screen.getByTestId('chat-subtitle').props.children).toBe(en.chatSubtitle);
    expect(screen.queryByText('Your AI assistant')).toBeNull();
    expect(screen.getByTestId('capture-ai-disclosure')).toBeTruthy();
    expect(screen.queryByText(en.aiDisclosure)).not.toBeNull();
    expect(screen.queryByText(en.aiDisclosureKept)).not.toBeNull();
    expect(screen.queryByTestId('capture-ai-off')).toBeNull();
    await fireEvent.press(screen.getByTestId('chat-more'));
    await waitFor(() => expect(screen.queryByTestId('chat-menu')).not.toBeNull());
    expect(screen.queryByTestId('chat-menu-ai-off')).toBeNull();
  });
});
