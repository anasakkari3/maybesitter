/**
 * The chat's gentle question about «ما اتصرّفت فيها» (lane E3), through the
 * real Root and the route's own fixture (`capture.chatFollowUp.json`).
 *
 * What these hold:
 *   - the question sits after the reply, worded from the items: when, never
 *     how late, and no blame;
 *   - every answer is a 44-point target whose label names the item; done,
 *     «أسقطه بوعي» and «لا تسألني عنها» go through the place's own routes;
 *   - «تخطّى» writes nothing and the answers go;
 *   - one per capture session: the next message says `followUpShown`, and a
 *     second follow-up from the server is never shown;
 *   - the reducer's rules, on their own.
 */
import React from 'react';
import { AccessibilityInfo, StyleSheet } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { Root } from '../../../Root';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import en from '../../../i18n/locales/en.json';
import ar from '../../../i18n/locales/ar.json';
import he from '../../../i18n/locales/he.json';
import * as captureEndpoints from '../../../api/endpoints/capture';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as analyticsEndpoints from '../../../api/endpoints/analytics';
import * as trustEndpoints from '../../../api/endpoints/trust';
import { captureChatSchema, type CaptureChatAnswer } from '../../../api/schemas/capture';
import followUpFixture from '../../../api/__fixtures__/capture.chatFollowUp.json';
import { captureReducer, initialCaptureState } from '../captureMachine';
import { chatTurn } from '../captureFlowActions';
import { followUpText } from '../ChatFollowUp';
import { stripIsolates } from '../../../i18n/bidi';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = { uid: 'follow-up-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'] };
const MEETING = 'fixture-unhandled-meeting';
const REPORT = 'fixture-unhandled-deadline';

const withFollowUp = (): CaptureChatAnswer => captureChatSchema.parse(followUpFixture);
const plain = (conversationId: string, text: string, followUp = false): CaptureChatAnswer => {
  const { followUp: _gone, ...rest } = followUpFixture;
  return captureChatSchema.parse({
    ...rest,
    ...(followUp ? { followUp: followUpFixture.followUp } : {}),
    conversationId,
    reply: 'OK.',
    turns: [...followUpFixture.turns, { role: 'user', text }, { role: 'assistant', text: 'OK.' }],
  });
};

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;
let chat: jest.SpiedFunction<typeof captureEndpoints.chatCapture>;

beforeEach(async () => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
  jest.spyOn(commitmentEndpoints, 'listUnhandled').mockResolvedValue({ items: [] } as never);
  jest.spyOn(commitmentEndpoints, 'actOnCommitment').mockResolvedValue(
    { data: { success: true, id: MEETING, commitment: {} }, etag: null } as never,
  );
  jest.spyOn(commitmentEndpoints, 'dismissUnhandled').mockResolvedValue({ success: true, id: MEETING, dismissed: true } as never);
  jest.spyOn(trustEndpoints, 'getTrust')
    .mockResolvedValue({ success: true, participantId: USER.uid, trust: { analyticsConsent: false } } as never);
  jest.spyOn(analyticsEndpoints, 'recordAnalyticsEvent')
    .mockResolvedValue({ success: true, participantId: USER.uid, recorded: true, eventId: 'e-1' } as never);
  chat = jest.spyOn(captureEndpoints, 'chatCapture');
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

async function say(text: string) {
  await fireEvent.changeText(screen.getByTestId('capture-input'), text);
  await fireEvent.press(screen.getByTestId('capture-analyze'));
}

const allText = (testID: string): string => stripIsolates(within(screen.getByTestId(testID)).queryAllByText(/./).map((node) => {
  const children = node.props.children as unknown;
  return Array.isArray(children) ? children.join('') : String(children);
}).join('\n'));

describe('the follow-up in the chat', () => {
  it('asks after the reply, names each item and when, and every answer names its item at 44 points', async () => {
    chat.mockResolvedValueOnce(withFollowUp());
    await openCapture();
    await say('hello');
    await waitFor(() => expect(screen.queryByTestId('chat-follow-up')).not.toBeNull());
    const words = allText('chat-follow-up');
    expect(words).toContain(en.chatFollowUpIntro);
    expect(words).toContain('“Meeting with Sami”');
    expect(words).toContain('did anything come out of it for you to do?');
    expect(words).toContain('“Hand in the report” was due');
    expect(words).not.toMatch(/late|overdue|missed|behind/i);
    const expected: [string, string, string][] = [
      [`chat-follow-up-tell-${MEETING}`, en.chatFollowUpTell, 'Meeting with Sami'],
      [`chat-follow-up-done-${MEETING}`, en.done, 'Meeting with Sami'],
      [`chat-follow-up-new-date-${MEETING}`, en.unhandledNewDate, 'Meeting with Sami'],
      [`chat-follow-up-drop-${MEETING}`, en.dropIt, 'Meeting with Sami'],
      [`chat-follow-up-dont-ask-${MEETING}`, en.unhandledDontAsk, 'Meeting with Sami'],
      [`chat-follow-up-done-${REPORT}`, en.done, 'Hand in the report'],
      [`chat-follow-up-dont-ask-${REPORT}`, en.unhandledDontAsk, 'Hand in the report'],
    ];
    for (const [id, label, title] of expected) {
      const button = screen.getByTestId(id);
      expect(button.props.accessibilityLabel).toBe(`${label}: ${title}`);
      const style = StyleSheet.flatten(button.props.style) as { minHeight?: number; minWidth?: number };
      expect(style.minHeight).toBeGreaterThanOrEqual(44);
      expect(style.minWidth).toBeGreaterThanOrEqual(44);
    }
    // «Something came of it» is for an appointment; a deadline is done or not.
    expect(screen.queryByTestId(`chat-follow-up-tell-${REPORT}`)).toBeNull();
    const skip = screen.getByTestId('chat-follow-up-skip');
    expect(skip.props.accessibilityLabel).toBe(en.chatFollowUpSkipLabel);
    expect((StyleSheet.flatten(skip.props.style) as { minHeight?: number }).minHeight).toBeGreaterThanOrEqual(44);
  });

  it('a screen reader hears the question with the reply it came with', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
    chat.mockResolvedValueOnce(withFollowUp());
    await openCapture();
    await say('hello');
    await waitFor(() => expect(screen.queryByTestId('chat-follow-up')).not.toBeNull());
    await waitFor(() => expect(announce).toHaveBeenCalled());
    const said = stripIsolates(String(announce.mock.calls.at(-1)![0]));
    expect(said.startsWith(followUpFixture.reply)).toBe(true);
    expect(said).toContain(en.chatFollowUpIntro);
    expect(said).toContain('Hand in the report');
  });

  it('«Skip» writes nothing: the answers go, the question stays as words', async () => {
    chat.mockResolvedValueOnce(withFollowUp());
    await openCapture();
    await say('hello');
    await waitFor(() => expect(screen.queryByTestId('chat-follow-up-skip')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('chat-follow-up-skip'));
    expect(screen.queryByTestId('chat-follow-up-actions')).toBeNull();
    expect(screen.queryByTestId('chat-follow-up')).not.toBeNull();
    expect(commitmentEndpoints.dismissUnhandled).not.toHaveBeenCalled();
    expect(commitmentEndpoints.actOnCommitment).not.toHaveBeenCalled();
  });

  it('«Don\'t ask me about it», done and drop go through the place\'s own routes, and that item\'s answers go', async () => {
    chat.mockResolvedValueOnce(withFollowUp());
    await openCapture();
    await say('hello');
    await waitFor(() => expect(screen.queryByTestId(`chat-follow-up-dont-ask-${MEETING}`)).not.toBeNull());
    await fireEvent.press(screen.getByTestId(`chat-follow-up-dont-ask-${MEETING}`));
    await waitFor(() => expect(commitmentEndpoints.dismissUnhandled).toHaveBeenCalledWith(MEETING));
    await waitFor(() => expect(screen.queryByTestId(`chat-follow-up-item-${MEETING}`)).toBeNull());
    await fireEvent.press(screen.getByTestId(`chat-follow-up-done-${REPORT}`));
    await waitFor(() => expect(commitmentEndpoints.actOnCommitment).toHaveBeenCalledWith(REPORT, 'complete', expect.anything()));
    // Both answered: nothing is left to ask.
    await waitFor(() => expect(screen.queryByTestId('chat-follow-up-actions')).toBeNull());
  });

  it('a second press in the same frame sends once', async () => {
    chat.mockResolvedValueOnce(withFollowUp());
    await openCapture();
    await say('hello');
    await waitFor(() => expect(screen.queryByTestId(`chat-follow-up-drop-${MEETING}`)).not.toBeNull());
    let release: () => void = () => undefined;
    (commitmentEndpoints.actOnCommitment as jest.Mock).mockImplementation(() => new Promise((resolve) => {
      release = () => resolve({ data: { success: true, id: MEETING, commitment: {} }, etag: null });
    }));
    const drop = screen.getByTestId(`chat-follow-up-drop-${MEETING}`);
    const done = screen.getByTestId(`chat-follow-up-done-${MEETING}`);
    // Inside one act: the re-render that disables the buttons has not happened.
    await act(async () => {
      void fireEvent.press(drop);
      void fireEvent.press(drop);
      void fireEvent.press(done);
    });
    release();
    await waitFor(() => expect(screen.queryByTestId(`chat-follow-up-item-${MEETING}`)).toBeNull());
    expect(commitmentEndpoints.actOnCommitment).toHaveBeenCalledTimes(1);
    expect(commitmentEndpoints.actOnCommitment).toHaveBeenCalledWith(MEETING, 'cancel', expect.anything());
  });

  it('one per session: the next message says it was shown, and a second follow-up is never drawn', async () => {
    chat.mockResolvedValueOnce(withFollowUp())
      .mockResolvedValueOnce(plain(followUpFixture.conversationId, 'thanks', true));
    await openCapture();
    await say('hello');
    await waitFor(() => expect(screen.queryByTestId('chat-follow-up-actions')).not.toBeNull());
    expect(chat.mock.calls[0]![0]).not.toHaveProperty('followUpShown');
    await say('thanks');
    await waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(chat.mock.calls[1]![0]).toMatchObject({ followUpShown: true });
    await waitFor(() => expect(screen.queryAllByText('OK.').length).toBeGreaterThan(0));
    // The first stays as words where it was asked; its answers went with the next message.
    expect(screen.queryAllByTestId('chat-follow-up')).toHaveLength(1);
    expect(screen.queryByTestId('chat-follow-up-actions')).toBeNull();
  });
});

describe('the follow-up in the reducer', () => {
  const answered = (state = initialCaptureState()) => captureReducer(
    captureReducer(state, { type: 'textChanged', text: 'hello' }),
    { type: 'chatAnswered', answer: withFollowUp() },
  );

  it('is kept once, after the lines it arrived with, and open', () => {
    const state = answered();
    expect(state.followUp).toEqual({
      items: withFollowUp().followUp!.items, at: followUpFixture.turns.length, open: true, answered: [],
    });
    const again = captureReducer(captureReducer(state, { type: 'textChanged', text: 'more' }), { type: 'chatStarted' });
    const second = captureReducer(again, { type: 'chatAnswered', answer: plain(followUpFixture.conversationId, 'more', true) });
    expect(second.followUp).toEqual({ ...state.followUp, open: false });
  });

  it('closes on skip, on the next message, and once every item is answered; ignores an item it did not ask', () => {
    const state = answered();
    expect(captureReducer(state, { type: 'followUpSkipped' }).followUp?.open).toBe(false);
    expect(captureReducer(captureReducer(state, { type: 'textChanged', text: 'x' }), { type: 'chatStarted' }).followUp?.open).toBe(false);
    const one = captureReducer(state, { type: 'followUpAnswered', commitmentId: MEETING });
    expect(one.followUp).toMatchObject({ open: true, answered: [MEETING] });
    expect(captureReducer(one, { type: 'followUpAnswered', commitmentId: 'someone-else' })).toBe(one);
    expect(captureReducer(one, { type: 'followUpAnswered', commitmentId: REPORT }).followUp).toMatchObject({ open: false, answered: [MEETING, REPORT] });
  });

  it('a plain answer starts none', () => {
    const state = captureReducer(
      captureReducer(initialCaptureState(), { type: 'textChanged', text: 'hello' }),
      { type: 'chatAnswered', answer: plain('c-1', 'hello') },
    );
    expect(state.followUp).toBeNull();
  });
});

describe('the request', () => {
  it('says `followUpShown` only when the session showed one', async () => {
    const gateway = { chat: jest.fn(async (_input: Record<string, unknown>) => withFollowUp()) };
    const classify = () => ({ kind: 'network' as const });
    await chatTurn(gateway, null, 'hi', classify as never);
    await chatTurn(gateway, null, 'hi', classify as never, false, null, true);
    expect(gateway.chat.mock.calls[0]![0]).not.toHaveProperty('followUpShown');
    expect(gateway.chat.mock.calls[1]![0]).toMatchObject({ followUpShown: true });
  });
});

describe('the words', () => {
  const NOW = new Date('2026-08-10T09:00:00.000Z');
  const LATENESS = /late|overdue|missed|behind|تأخ|متأخر|فات|פספס|באיחור|מאחר/i;

  it.each([['en', en], ['ar', ar], ['he', he]] as [string, typeof en][])('%s: the question names the item and when, with no lateness word', (lang, copy) => {
    const text = stripIsolates(followUpText(withFollowUp().followUp!, copy, lang, 'Asia/Jerusalem', NOW));
    expect(text.split('\n')).toHaveLength(3);
    expect(text).toContain('Meeting with Sami');
    expect(text).toContain('Hand in the report');
    for (const key of ['chatFollowUpIntro', 'chatFollowUpEvent', 'chatFollowUpDeadline', 'chatFollowUpTell', 'chatFollowUpSkip', 'chatFollowUpSkipLabel'] as const) {
      expect(copy[key]).not.toMatch(LATENESS);
    }
  });
});
