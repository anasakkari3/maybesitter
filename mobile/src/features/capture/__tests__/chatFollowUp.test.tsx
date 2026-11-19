/**
 * The chat's gentle question about «ما اتصرّفت فيها» (lane E3), through the
 * real Root and the route's own fixture (`capture.chatFollowUp.json`).
 *
 * What these hold:
 *   - the question sits after the reply, worded from the items: when, never
 *     how late, and no blame;
 *   - one item, one primary answer (an appointment: «في إشي، رح احكيلك»; a
 *     deadline: «تمّ»), and «خيارات تانية» for a new date, «أسقطه بوعي» and
 *     «لا تسألني عنها»; «أسقطه بوعي» never looks like the primary answer, and
 *     «لا تسألني عنها» and «تخطّى» are plain text;
 *   - every answer is a 44-point target whose label names the item, and
 *     they go through the place's own routes;
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
const REPORT_ITEM = { commitmentId: REPORT, title: 'Hand in the report', reason: 'deadline_passed', since: '2026-08-09T09:00:00.000Z' };
const withDeadline = (): CaptureChatAnswer => captureChatSchema.parse({ ...followUpFixture, followUp: { items: [REPORT_ITEM] } });
const backgroundOf = (testID: string): unknown => (StyleSheet.flatten(screen.getByTestId(testID).props.style) as { backgroundColor?: unknown }).backgroundColor;
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
  it('asks after the reply about one appointment, with one primary answer and the rest behind «Other options»', async () => {
    chat.mockResolvedValueOnce(withFollowUp());
    await openCapture();
    await say('hello');
    await waitFor(() => expect(screen.queryByTestId('chat-follow-up')).not.toBeNull());
    const words = allText('chat-follow-up');
    expect(words).toContain(en.chatFollowUpIntro);
    expect(words).toContain('“Meeting with Sami”');
    expect(words).toContain('did anything come out of it you want to do?');
    expect(words).not.toMatch(/late|overdue|missed|behind|have to|must/i);
    // The primary answer, and the way to the others; nothing else yet.
    expect(screen.getByTestId(`chat-follow-up-tell-${MEETING}`).props.accessibilityLabel).toBe(`${en.chatFollowUpTell}: Meeting with Sami`);
    expect(screen.getByTestId(`chat-follow-up-more-${MEETING}`).props.accessibilityLabel).toBe(`${en.chatFollowUpMore}: Meeting with Sami`);
    expect(screen.getByTestId(`chat-follow-up-more-${MEETING}`).props.accessibilityState).toMatchObject({ expanded: false });
    for (const hidden of ['done', 'nothing-came', 'new-date', 'drop', 'dont-ask']) {
      expect(screen.queryByTestId(`chat-follow-up-${hidden}-${MEETING}`)).toBeNull();
    }
    await fireEvent.press(screen.getByTestId(`chat-follow-up-more-${MEETING}`));
    expect(screen.getByTestId(`chat-follow-up-more-${MEETING}`).props.accessibilityState).toMatchObject({ expanded: true });
    const expected: [string, string][] = [
      [`chat-follow-up-tell-${MEETING}`, en.chatFollowUpTell],
      [`chat-follow-up-more-${MEETING}`, en.chatFollowUpMore],
      [`chat-follow-up-nothing-came-${MEETING}`, en.chatFollowUpNothingCame],
      [`chat-follow-up-new-date-${MEETING}`, en.unhandledNewDate],
      [`chat-follow-up-drop-${MEETING}`, en.dropIt],
      [`chat-follow-up-dont-ask-${MEETING}`, en.unhandledDontAsk],
    ];
    for (const [id, label] of expected) {
      const button = screen.getByTestId(id);
      expect(button.props.accessibilityLabel).toBe(`${label}: Meeting with Sami`);
      const style = StyleSheet.flatten(button.props.style) as { minHeight?: number; minWidth?: number };
      expect(style.minHeight).toBeGreaterThanOrEqual(44);
      expect(style.minWidth).toBeGreaterThanOrEqual(44);
    }
    // «Drop on purpose» never wears the primary answer's look; the quiet two are plain text.
    expect(backgroundOf(`chat-follow-up-drop-${MEETING}`)).not.toEqual(backgroundOf(`chat-follow-up-tell-${MEETING}`));
    expect(backgroundOf(`chat-follow-up-dont-ask-${MEETING}`)).toBeUndefined();
    expect(backgroundOf('chat-follow-up-skip')).toBeUndefined();
    // Done is a deadline's answer, not an appointment's.
    expect(screen.queryByTestId(`chat-follow-up-done-${MEETING}`)).toBeNull();
    const skip = screen.getByTestId('chat-follow-up-skip');
    expect(skip.props.accessibilityLabel).toBe(en.chatFollowUpSkipLabel);
    expect((StyleSheet.flatten(skip.props.style) as { minHeight?: number }).minHeight).toBeGreaterThanOrEqual(44);
  });

  it('«Nothing came of it, done» closes an appointment from the question itself', async () => {
    chat.mockResolvedValueOnce(withFollowUp());
    await openCapture();
    await say('hello');
    await waitFor(() => expect(screen.queryByTestId(`chat-follow-up-more-${MEETING}`)).not.toBeNull());
    await fireEvent.press(screen.getByTestId(`chat-follow-up-more-${MEETING}`));
    await fireEvent.press(screen.getByTestId(`chat-follow-up-nothing-came-${MEETING}`));
    await waitFor(() => expect(commitmentEndpoints.actOnCommitment).toHaveBeenCalledWith(MEETING, 'complete', expect.anything()));
    await waitFor(() => expect(screen.queryByTestId('chat-follow-up-actions')).toBeNull());
  });

  it('a deadline is asked as one, and its primary answer is «Done»', async () => {
    chat.mockResolvedValueOnce(withDeadline());
    await openCapture();
    await say('hello');
    await waitFor(() => expect(screen.queryByTestId('chat-follow-up')).not.toBeNull());
    expect(allText('chat-follow-up')).toContain('The “Hand in the report” deadline was');
    const done = screen.getByTestId(`chat-follow-up-done-${REPORT}`);
    expect(done.props.accessibilityLabel).toBe(`${en.chatFollowUpDone}: Hand in the report`);
    expect(screen.queryByTestId(`chat-follow-up-tell-${REPORT}`)).toBeNull();
    // Its «Done» is already the primary answer: not offered twice.
    await fireEvent.press(screen.getByTestId(`chat-follow-up-more-${REPORT}`));
    expect(screen.queryByTestId(`chat-follow-up-nothing-came-${REPORT}`)).toBeNull();
    await fireEvent.press(done);
    await waitFor(() => expect(commitmentEndpoints.actOnCommitment).toHaveBeenCalledWith(REPORT, 'complete', expect.anything()));
    await waitFor(() => expect(screen.queryByTestId('chat-follow-up-actions')).toBeNull());
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
    expect(said).toContain('Meeting with Sami');
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

  it('«Don\'t ask me about it» goes through the place\'s own route, and the answers go', async () => {
    chat.mockResolvedValueOnce(withFollowUp());
    await openCapture();
    await say('hello');
    await waitFor(() => expect(screen.queryByTestId(`chat-follow-up-more-${MEETING}`)).not.toBeNull());
    await fireEvent.press(screen.getByTestId(`chat-follow-up-more-${MEETING}`));
    await fireEvent.press(screen.getByTestId(`chat-follow-up-dont-ask-${MEETING}`));
    await waitFor(() => expect(commitmentEndpoints.dismissUnhandled).toHaveBeenCalledWith(MEETING));
    await waitFor(() => expect(screen.queryByTestId('chat-follow-up-actions')).toBeNull());
    expect(commitmentEndpoints.actOnCommitment).not.toHaveBeenCalled();
  });

  it('a second press in the same frame sends once', async () => {
    chat.mockResolvedValueOnce(withFollowUp());
    await openCapture();
    await say('hello');
    await waitFor(() => expect(screen.queryByTestId(`chat-follow-up-more-${MEETING}`)).not.toBeNull());
    await fireEvent.press(screen.getByTestId(`chat-follow-up-more-${MEETING}`));
    let release: () => void = () => undefined;
    (commitmentEndpoints.actOnCommitment as jest.Mock).mockImplementation(() => new Promise((resolve) => {
      release = () => resolve({ data: { success: true, id: MEETING, commitment: {} }, etag: null });
    }));
    const drop = screen.getByTestId(`chat-follow-up-drop-${MEETING}`);
    const dontAsk = screen.getByTestId(`chat-follow-up-dont-ask-${MEETING}`);
    // Inside one act: the re-render that disables the buttons has not happened.
    await act(async () => {
      void fireEvent.press(drop);
      void fireEvent.press(drop);
      void fireEvent.press(dontAsk);
    });
    release();
    await waitFor(() => expect(screen.queryByTestId(`chat-follow-up-item-${MEETING}`)).toBeNull());
    expect(commitmentEndpoints.actOnCommitment).toHaveBeenCalledTimes(1);
    expect(commitmentEndpoints.actOnCommitment).toHaveBeenCalledWith(MEETING, 'cancel', expect.anything());
    expect(commitmentEndpoints.dismissUnhandled).not.toHaveBeenCalled();
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
    expect(captureReducer(state, { type: 'followUpAnswered', commitmentId: 'someone-else' })).toBe(state);
    expect(captureReducer(state, { type: 'followUpAnswered', commitmentId: MEETING }).followUp).toMatchObject({ open: false, answered: [MEETING] });
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
  const LATENESS = /late|overdue|missed|behind|have to|must|تأخ|متأخر|فات|لازم|פספס|באיחור|מאחר|חייב/i;

  it('the owner\'s wording: what you want to do, and a deadline named as a deadline', () => {
    expect(ar.chatFollowUpEvent).toBe('«{title}» {when} — طلع منه إشي بدك تعمله؟');
    expect(ar.chatFollowUpDeadline).toBe('تسليم «{title}» كان {when} — تمّ؟');
    expect(ar.chatFollowUpDone).toBe('تمّ');
    expect(ar.chatFollowUpNothingCame).toBe('ما طلع منه إشي، تمّت');
  });

  it.each([['en', en], ['ar', ar], ['he', he]] as [string, typeof en][])('%s: the question names the item and when, with no lateness word', (lang, copy) => {
    const meeting = stripIsolates(followUpText(withFollowUp().followUp!, copy, lang, 'Asia/Jerusalem', NOW));
    expect(meeting.split('\n')).toHaveLength(2);
    expect(meeting).toContain('Meeting with Sami');
    const report = stripIsolates(followUpText(withDeadline().followUp!, copy, lang, 'Asia/Jerusalem', NOW));
    expect(report).toContain('Hand in the report');
    for (const key of ['chatFollowUpIntro', 'chatFollowUpEvent', 'chatFollowUpDeadline', 'chatFollowUpTell', 'chatFollowUpDone', 'chatFollowUpNothingCame', 'chatFollowUpMore', 'chatFollowUpSkip', 'chatFollowUpSkipLabel'] as const) {
      expect(copy[key]).not.toMatch(LATENESS);
    }
  });

  it('an all-day item is named by its own day, not the midnight after it', () => {
    // The doctor on Sun 2026-08-09, all day, in Jerusalem: over at Mon 00:00 (since), shown on Sunday.
    const doctor = { commitmentId: 'd', title: 'Doctor', reason: 'event_ended' as const, since: '2026-08-09T21:00:00.000Z', shownAt: '2026-08-08T21:00:00.000Z' };
    const line = stripIsolates(followUpText({ items: [doctor] }, en, 'en', 'Asia/Jerusalem', NOW));
    expect(line).toContain(en.yesterday);
    // An answer saved before `shownAt` existed still reads: its `since`.
    const { shownAt: _old, ...stored } = doctor;
    expect(stripIsolates(followUpText({ items: [stored] }, en, 'en', 'Asia/Jerusalem', NOW))).not.toContain(en.yesterday);
  });
});
