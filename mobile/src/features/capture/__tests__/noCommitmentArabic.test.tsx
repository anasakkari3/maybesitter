/**
 * "Nothing to save", in Arabic, in the capture chat (#166, #338; owner
 * decision 2026-09-30).
 *
 * The composer's sends go to the chat now, and a message that names nothing
 * is answered by the assistant: the server writes that reply in the person's
 * language (its `templateReply` speaks to #166's reason codes) and sends
 * `proposal: null`. So what the phone owes an Arabic reader here is the frame
 * around the reply: the reply itself shown as sent, right to left in the
 * Arabic face; no card and no confirm; and its own chrome — the opening line
 * and the AI disclosure — in Arabic, with no English beside it.
 *
 * The full-screen neutral line (`noCommitmentLine`) still exists for a
 * proposal that arrives some other way; its words are held to #166's rules by
 * `noCommitmentCopy.test.ts`.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';
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
import en from '../../../i18n/locales/en.json';
import { isolateLatinRuns } from '../../../i18n/bidi';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';

import * as captureEndpoints from '../../../api/endpoints/capture';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as analyticsEndpoints from '../../../api/endpoints/analytics';
import * as trustEndpoints from '../../../api/endpoints/trust';
import { chatServer } from '../../../testing/captureChat';

// Hoisted above the imports so `src/i18n/timezone` sees it. The zone is not
// what this file is about; it is pinned to somewhere no host is set to so that
// nothing here can pass by agreeing with the machine it runs on.
jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Pacific/Marquesas' }]),
  getLocales: jest.fn(() => [{ languageCode: 'ar', languageTag: 'ar-JO', textDirection: 'rtl' }]),
}));

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = {
  uid: 'nothing-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

/** What the person wrote, and the Arabic the server answers with. */
const TYPED = 'مرحبا، كيفك اليوم';
const REPLY = 'أهلين! شو بدك أسجّلك؟';

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

function nothing(reason: string | undefined) {
  return {
    version: 'v1',
    proposalId: 'p-1',
    status: 'no_commitment',
    ...(reason === undefined ? {} : { noCommitmentReason: reason }),
    items: [],
    provenance: { requestedEngine: 'rules', executedEngine: 'rule-based', fallbackUsed: false },
  };
}

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
});

afterEach(() => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

type Node = { props?: Record<string, unknown>; children?: unknown };

/** The first `direction` any box in the tree sets. Root sets exactly one. */
function renderedDirection(tree: unknown): string | undefined {
  const node = tree as Node | null;
  if (!node || typeof node !== 'object') return undefined;
  for (const style of [node.props?.style].flat(4)) {
    if (style && typeof style === 'object' && 'direction' in style) {
      return (style as { direction?: string }).direction;
    }
  }
  for (const child of [node.children].flat(2)) {
    const found = renderedDirection(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** One style property off a rendered node, whatever shape its `style` is in. */
function styleOf(node: { props: Record<string, unknown> }, key: string): unknown {
  return [node.props.style].flat(4)
    .map(style => (style && typeof style === 'object' ? (style as Record<string, unknown>)[key] : undefined))
    .find(value => value !== undefined);
}

/**
 * Open the app in Arabic, type, send, and wait for the assistant's reply.
 *
 * Every `render`/`fireEvent` is awaited: RNTL v14's `render` is async, and an
 * un-awaited one leaves the *next* test mounting nothing and passing against
 * an empty tree.
 */
async function sendNothing(reason: string | undefined) {
  jest.spyOn(captureEndpoints, 'chatCapture').mockImplementation(chatServer(() => nothing(reason), { reply: () => REPLY }) as never);
  const view = await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}><Root /></QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('tab-capture')).not.toBeNull());
  // The stored preference is read in an effect, so the first frame is still
  // the fallback language. Reading the screen before this is reading English.
  await waitFor(() => expect(screen.queryByText(ar.tabToday)).not.toBeNull());
  await fireEvent.press(screen.getByTestId('tab-capture'));
  await waitFor(() => expect(screen.queryByTestId('capture-input')).not.toBeNull());
  await fireEvent.changeText(screen.getByTestId('capture-input'), TYPED);
  await fireEvent.press(screen.getByTestId('capture-analyze'));
  await waitFor(() => expect(screen.queryByText(REPLY)).not.toBeNull());
  return view;
}

describe('nothing to save, said in Arabic, in the chat (#166)', () => {
  it.each(['greeting_or_chat', 'question', undefined])('answers %s with the reply and no card', async reason => {
    await sendNothing(reason);
    expect(screen.queryByTestId('chat-schedule')).toBeNull();
    expect(screen.queryByTestId('review-confirm')).toBeNull();
    // The app's own chrome is Arabic, not English.
    expect(screen.queryByText(ar.chatWelcome)).not.toBeNull();
    // Shown with its Latin brand runs isolated (chat UAT 2026-09-30).
    expect(screen.queryByText(isolateLatinRuns(ar.aiDisclosure))).not.toBeNull();
    expect(screen.queryByText(en.chatWelcome)).toBeNull();
    expect(screen.queryByText(en.aiDisclosure)).toBeNull();
  });

  it('reads right to left, in the Arabic face, and the person\'s words appear only in their own bubble', async () => {
    const view = await sendNothing('greeting_or_chat');
    const reply = screen.getByText(REPLY);

    expect(renderedDirection(view.toJSON())).toBe('rtl');
    // Outfit has no Arabic glyphs at all, so the wrong face here is a screen
    // of tofu that no assertion on the string alone would notice.
    expect(styleOf(reply, 'fontFamily')).toBe('NotoKufiArabic_400Regular');
    expect(styleOf(reply, 'writingDirection')).toBe('rtl');
    // What they wrote is their own message, once, and nowhere else.
    expect(screen.getAllByText(new RegExp(TYPED))).toHaveLength(1);
    expect(screen.getByTestId('chat-turn-text-0').props.children).toBe(TYPED);
    // And the field is ready for the next message.
    expect(screen.getByTestId('capture-input').props.value).toBe('');
  });
});
