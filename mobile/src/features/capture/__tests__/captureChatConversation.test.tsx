/**
 * The capture chat «احكيها», turn by turn, through the real Root (owner
 * decision 2026-09-30).
 *
 * Every composer send is `POST /api/mobile/capture/chat` in the current
 * conversation. What these hold:
 *
 *   - a send shows the person's message, the assistant's reply as sent, and
 *     the proposal's cards under it;
 *   - a follow-up goes in the same conversation and its proposal replaces the
 *     one on screen;
 *   - the reply is words: whatever it says, nothing is saved and nothing reads
 *     "saved" until the confirm the person pressed succeeds;
 *   - confirm and the one question's options keep using `/capture/confirm` and
 *     `/capture/clarify` on the proposal on screen;
 *   - a conversation the server no longer has is restarted with the same
 *     message exactly once — never a loop;
 *   - the rules' answer (no model) works the same way, on the route's own
 *     fixture;
 *   - «ابدأ من جديد» starts a new conversation; a failed send keeps the
 *     message, and Back returns to the conversation.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
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
import * as captureEndpoints from '../../../api/endpoints/capture';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as analyticsEndpoints from '../../../api/endpoints/analytics';
import * as trustEndpoints from '../../../api/endpoints/trust';
import { ConversationNotFoundError, InputTooLargeError, NetworkError } from '../../../api/errors';
import { captureChatSchema, type CaptureChatAnswer, type CaptureProposal } from '../../../api/schemas/capture';
import chatRules from '../../../api/__fixtures__/capture.chatRules.json';
import { chatServer } from '../../../testing/captureChat';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = { uid: 'chat-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'] };
const at = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
const FIVE = at(20);
const SIX = at(21);

function dentist(proposalId: string, itemId: string, resolvedTime: string, over: Partial<CaptureProposal> = {}): CaptureProposal {
  return {
    version: 'v1', proposalId, status: 'proposed', seeds: [],
    items: [{ itemId, title: 'Call the dentist', resolvedTime, needsClarification: false }],
    ...over,
  };
}

function confirmation(itemId: string, resolvedTime: string) {
  return {
    success: true, replayed: false, failed: [],
    persisted: [{ itemId, commitmentId: 'c-1', title: 'Call the dentist', resolvedTime }],
  };
}

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(async () => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
  jest.spyOn(trustEndpoints, 'getTrust')
    .mockResolvedValue({ success: true, participantId: USER.uid, trust: { analyticsConsent: false } } as never);
  jest.spyOn(analyticsEndpoints, 'recordAnalyticsEvent')
    .mockResolvedValue({ success: true, participantId: USER.uid, recorded: true, eventId: 'e-1' } as never);
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

const textOf = (testID: string): string => {
  const children = screen.getByTestId(testID).props.children as unknown;
  return Array.isArray(children) ? children.join('') : String(children);
};
const field = () => screen.getByTestId('capture-input').props.value as string;

/** The chat, answering the n-th message with `answers[n]` and `replies[n]`. */
function conversation(answers: CaptureProposal[], replies: string[]) {
  return jest.spyOn(captureEndpoints, 'chatCapture').mockImplementation(chatServer(
    (_message, call) => answers[call] ?? null,
    { reply: (_message, _proposal, call) => replies[call] ?? replies[replies.length - 1]!, engine: 'model' },
  ) as never);
}

describe('a conversation, turn by turn', () => {
  it('a send shows the message, the reply as sent, and the proposal’s cards under it', async () => {
    const chat = conversation([dentist('p-1', 'i-1', FIVE)], ['Call the dentist tomorrow at 5pm. Check it and confirm.']);
    await openCapture();
    // The disclosure is on the page before anything is sent.
    expect(screen.queryByTestId('capture-ai-disclosure')).not.toBeNull();
    await say('Remind me to call the dentist tomorrow at 5pm');
    await waitFor(() => expect(screen.queryByTestId('review-item-i-1')).not.toBeNull());

    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0]![0]).toMatchObject({ conversationId: null, message: 'Remind me to call the dentist tomorrow at 5pm' });
    expect(textOf('chat-turn-text-0')).toBe('Remind me to call the dentist tomorrow at 5pm');
    expect(screen.queryByText('Call the dentist tomorrow at 5pm. Check it and confirm.')).not.toBeNull();
    expect(screen.queryByTestId('chat-turn-assistant-1')).not.toBeNull();
    expect(screen.getByTestId('review-note').props.children).toBe(en.suggestionNote);
    // The field is empty, ready for the next message.
    expect(field()).toBe('');
  });

  it('a follow-up goes in the same conversation, and its proposal replaces the card', async () => {
    const chat = conversation(
      [dentist('p-1', 'i-1', FIVE), dentist('p-2', 'i-2', SIX)],
      ['Call the dentist tomorrow at 5pm.', 'Okay, 6pm instead.'],
    );
    const confirm = jest.spyOn(captureEndpoints, 'confirmCapture').mockResolvedValue(confirmation('i-2', SIX) as never);
    await openCapture();
    await say('Remind me to call the dentist tomorrow at 5pm');
    await waitFor(() => expect(screen.queryByTestId('review-item-i-1')).not.toBeNull());
    const first = await chat.mock.results[0]!.value as CaptureChatAnswer;

    await say('make it 6pm');
    await waitFor(() => expect(screen.queryByTestId('review-item-i-2')).not.toBeNull());
    expect(chat.mock.calls[1]![0]).toMatchObject({ conversationId: first.conversationId, message: 'make it 6pm' });
    // The old card is gone; the new one is what a confirm would save.
    expect(screen.queryByTestId('review-item-i-1')).toBeNull();
    expect(screen.queryByText('Okay, 6pm instead.')).not.toBeNull();
    // Both of the person's messages are in the conversation, in order.
    expect(textOf('chat-turn-text-0')).toBe('Remind me to call the dentist tomorrow at 5pm');
    expect(textOf('chat-turn-text-2')).toBe('make it 6pm');

    await fireEvent.press(screen.getByTestId('review-confirm'));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm.mock.calls[0]![0]).toMatchObject({ proposalId: 'p-2', itemIds: ['i-2'] });
    await waitFor(() => expect(screen.queryByTestId('saved-title')).not.toBeNull());
  });

  it('a reply that says "saved" saves nothing: no saved screen, no confirm, until the person presses it', async () => {
    conversation([dentist('p-1', 'i-1', FIVE)], ['Done! I saved it to your list.']);
    const confirm = jest.spyOn(captureEndpoints, 'confirmCapture');
    await openCapture();
    await say('Remind me to call the dentist tomorrow at 5pm');
    await waitFor(() => expect(screen.queryByText('Done! I saved it to your list.')).not.toBeNull());

    expect(screen.queryByTestId('saved-title')).toBeNull();
    expect(screen.queryByTestId('review-confirm')).not.toBeNull();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('a question’s option is answered through /capture/clarify on the proposal on screen, not by the chat', async () => {
    const asking = dentist('p-1', 'i-1', FIVE, {
      status: 'needs_clarification',
      items: [{
        itemId: 'i-1', title: 'Call the dentist', resolvedTime: null, needsClarification: true,
        clarification: {
          questionId: 'q-1', field: 'time', questionKey: 'ask_time', params: {}, allowFreeText: false,
          options: [
            { optionId: 'morning', labelKey: 'morning', labelParams: {}, value: { localTime: '09:00' } },
            { optionId: 'none', labelKey: 'noTime', labelParams: {}, value: {} },
          ],
        },
      }],
    });
    const chat = conversation([asking], ['When should I remind you?']);
    const clarify = jest.spyOn(captureEndpoints, 'clarifyCapture').mockResolvedValue(dentist('p-1', 'i-1', FIVE));
    await openCapture();
    await say('Call the dentist tomorrow');
    await waitFor(() => expect(screen.queryByTestId('clarify-option-morning')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('clarify-option-morning'));
    await waitFor(() => expect(clarify).toHaveBeenCalledTimes(1));
    expect(clarify.mock.calls[0]![0]).toMatchObject({ proposalId: 'p-1', itemId: 'i-1', questionId: 'q-1', optionId: 'morning' });
    expect(chat).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('clarify-sheet')).toBeNull());
    expect(screen.getByTestId('review-confirm').props.accessibilityState.disabled).toBe(false);
  });
});

describe('chat UAT details (2026-09-30)', () => {
  it('the disclosure on the chat page has its heading, as on Trust', async () => {
    conversation([], ['unused']);
    await openCapture();
    const disclosure = screen.getByTestId('capture-ai-disclosure');
    expect(disclosure).toBeTruthy();
    expect(textOf('capture-ai-disclosure-title')).toBe(en.aiDisclosureTitle);
  });

  it('«حزرناها» sits beside a «لازم» it qualifies, never alone under a time the person said', async () => {
    conversation([{
      version: 'v1', proposalId: 'p-1', status: 'proposed', seeds: [],
      items: [
        { itemId: 'i-1', title: 'Dentist appointment', resolvedTime: FIVE, needsClarification: false, priority: 'normal', priorityEstimated: true },
        { itemId: 'i-2', title: 'Hand in the report', resolvedTime: SIX, needsClarification: false, priority: 'high', priorityEstimated: true },
      ],
    } as CaptureProposal], ['Dentist and the report. Confirm below.']);
    await openCapture();
    await say('Dentist tomorrow at 4pm, and the report is a must at 5pm');
    await waitFor(() => expect(screen.queryByTestId('review-item-i-1')).not.toBeNull());
    expect(screen.queryByTestId('review-estimated-i-1')).toBeNull();
    expect(screen.queryByTestId('review-priority-i-1')).toBeNull();
    expect(screen.queryByTestId('review-priority-i-2')).not.toBeNull();
    expect(screen.queryByTestId('review-estimated-i-2')).not.toBeNull();
  });

  it('a routine kept weekly is titled as the block («Internship»), not with «every Saturday» in it', async () => {
    conversation([{
      version: 'v1', proposalId: 'p-1', status: 'proposed', seeds: [],
      items: [{
        itemId: 'i-1', title: 'Internship every Saturday', resolvedTime: FIVE, needsClarification: false,
        recurrenceHint: { weekdays: [6], start: '10:00', end: '16:00' },
        weeklyBlock: { title: 'Internship', weekdays: [6], start: '10:00', end: '16:00', timezone: 'Asia/Jerusalem' },
      }],
    } as CaptureProposal], ['An internship every Saturday from 10 to 4. Confirm below.']);
    await openCapture();
    await say('I have an internship every Saturday from 10 to 4');
    await waitFor(() => expect(screen.queryByTestId('review-item-i-1')).not.toBeNull());
    expect(textOf('review-title-i-1')).toBe('Internship');
  });

  it('leaving a touched proposal offers «Back to the proposal», not «Keep writing»', async () => {
    conversation([{
      version: 'v1', proposalId: 'p-1', status: 'proposed', seeds: [],
      items: [
        { itemId: 'i-1', title: 'Call the dentist', resolvedTime: FIVE, needsClarification: false },
        { itemId: 'i-2', title: 'Buy bread', resolvedTime: SIX, needsClarification: false },
      ],
    } as CaptureProposal], ['Two things. Confirm below.']);
    await openCapture();
    await say('Dentist at 5 and bread at 6');
    await waitFor(() => expect(screen.queryByTestId('review-item-i-1')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('review-item-i-2'));
    await fireEvent.press(screen.getByTestId('review-back'));
    await waitFor(() => expect(screen.queryByTestId('capture-discard')).not.toBeNull());
    expect(screen.queryByText(en.chatBackToProposal)).not.toBeNull();
    expect(screen.queryByText(en.captureKeepEditing)).toBeNull();
    await fireEvent.press(screen.getByTestId('capture-discard-keep'));
    await waitFor(() => expect(screen.queryByTestId('review-item-i-1')).not.toBeNull());
  });
});

describe('while a message is on its way', () => {
  it('shows it as a bubble with the typing reply, locks the field, and the examples do not come back', async () => {
    // The answer waits for the test to let it through.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const server = chatServer(() => dentist('p-1', 'i-1', FIVE));
    jest.spyOn(captureEndpoints, 'chatCapture').mockImplementation((async (input: { conversationId: string | null; message: string }) => {
      await gate;
      return server(input);
    }) as never);
    await openCapture();
    expect(screen.queryByTestId('chat-quick-actions')).not.toBeNull();
    await say('Remind me to call the dentist tomorrow at 5pm');

    await waitFor(() => expect(screen.queryByTestId('chat-typing')).not.toBeNull());
    expect(textOf('chat-turn-text-0')).toBe('Remind me to call the dentist tomorrow at 5pm');
    expect(screen.getByTestId('chat-typing').props.accessibilityLabel).toBe(en.understanding);
    expect(screen.getByTestId('capture-input').props.editable).toBe(false);
    expect(field()).toBe('');
    // Back still works while it is on its way.
    expect(screen.getByTestId('capture-cancel').props.accessibilityState.disabled).toBe(false);

    await React.act(async () => { release(); });
    await waitFor(() => expect(screen.queryByTestId('review-item-i-1')).not.toBeNull());
    expect(screen.queryByTestId('chat-typing')).toBeNull();
    expect(screen.getByTestId('capture-input').props.editable).toBe(true);
    // Examples are for an empty, new conversation only.
    expect(screen.queryByTestId('chat-quick-actions')).toBeNull();
  });
});

describe('a conversation the server no longer has', () => {
  it('is restarted with the same message, exactly once', async () => {
    const server = chatServer((_message, call) => dentist(`p-${call}`, `i-${call}`, FIVE));
    const chat = jest.spyOn(captureEndpoints, 'chatCapture')
      .mockImplementationOnce(server as never)
      .mockRejectedValueOnce(new ConversationNotFoundError('conversation not found'))
      .mockImplementation(server as never);
    await openCapture();
    await say('Remind me to call the dentist tomorrow at 5pm');
    await waitFor(() => expect(screen.queryByTestId('review-item-i-0')).not.toBeNull());
    const first = await chat.mock.results[0]!.value as CaptureChatAnswer;

    await say('make it 6pm');
    await waitFor(() => expect(screen.queryByTestId('review-item-i-1')).not.toBeNull());
    expect(chat).toHaveBeenCalledTimes(3);
    expect(chat.mock.calls[1]![0]).toMatchObject({ conversationId: first.conversationId, message: 'make it 6pm' });
    // The one retry: the same words, as the start of a new conversation.
    expect(chat.mock.calls[2]![0]).toMatchObject({ conversationId: null, message: 'make it 6pm' });
    expect(screen.queryByTestId('capture-error-extractionFailed')).toBeNull();
  });

  it('a second not-found is reported, not retried again', async () => {
    const server = chatServer(() => dentist('p-1', 'i-1', FIVE));
    const chat = jest.spyOn(captureEndpoints, 'chatCapture')
      .mockImplementationOnce(server as never)
      .mockRejectedValue(new ConversationNotFoundError('conversation not found'));
    await openCapture();
    await say('Remind me to call the dentist tomorrow at 5pm');
    await waitFor(() => expect(screen.queryByTestId('review-item-i-1')).not.toBeNull());

    await say('make it 6pm');
    await waitFor(() => expect(screen.queryByTestId('capture-error-message')).not.toBeNull());
    expect(chat).toHaveBeenCalledTimes(3);
    expect(textOf('capture-error-message')).toBe(en.errorsNotFound);
  });
});

describe('the rules’ answer, when no model is available', () => {
  it('reads the route’s own fixture: its Arabic reply and its card', async () => {
    const answer = captureChatSchema.parse(chatRules);
    expect(answer.engine).toBe('rules');
    jest.spyOn(captureEndpoints, 'chatCapture').mockResolvedValue(answer);
    await openCapture();
    await say(answer.turns[0]!.text);
    const itemId = answer.proposal!.items[0]!.itemId;
    await waitFor(() => expect(screen.queryByTestId(`review-item-${itemId}`)).not.toBeNull());
    expect(screen.queryByText(answer.reply)).not.toBeNull();
    expect(textOf(`review-title-${itemId}`)).toBe(answer.proposal!.items[0]!.title);
  });
});

describe('starting over, and failures', () => {
  it('«Start over» in the ⋯ menu starts a new conversation', async () => {
    const chat = jest.spyOn(captureEndpoints, 'chatCapture')
      .mockImplementation(chatServer((_message, call) => dentist(`p-${call}`, `i-${call}`, FIVE)) as never);
    await openCapture();
    await say('Remind me to call the dentist tomorrow at 5pm');
    await waitFor(() => expect(screen.queryByTestId('review-item-i-0')).not.toBeNull());

    await fireEvent.press(screen.getByTestId('chat-more'));
    await waitFor(() => expect(screen.queryByTestId('chat-menu-start-over')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('chat-menu-start-over'));
    await waitFor(() => expect(screen.queryByTestId('chat-turn-text-0')).toBeNull());
    expect(screen.queryByTestId('review-item-i-0')).toBeNull();
    expect(field()).toBe('');

    await say('Buy stamps');
    await waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(chat.mock.calls[1]![0]).toMatchObject({ conversationId: null, message: 'Buy stamps' });
  });

  it('offline: the error screen with Retry, and Back returns to the conversation with the message kept', async () => {
    const server = chatServer(() => dentist('p-1', 'i-1', FIVE));
    const chat = jest.spyOn(captureEndpoints, 'chatCapture')
      .mockImplementationOnce(server as never)
      .mockRejectedValueOnce(new NetworkError('offline'));
    await openCapture();
    await say('Remind me to call the dentist tomorrow at 5pm');
    await waitFor(() => expect(screen.queryByTestId('review-item-i-1')).not.toBeNull());
    await say('make it 6pm');
    await waitFor(() => expect(screen.queryByTestId('capture-error-networkError')).not.toBeNull());
    expect(screen.queryByTestId('capture-retry')).not.toBeNull();
    expect(chat).toHaveBeenCalledTimes(2);

    await fireEvent.press(screen.getByTestId('capture-error-back'));
    await waitFor(() => expect(screen.queryByTestId('review-item-i-1')).not.toBeNull());
    expect(field()).toBe('make it 6pm');
    expect(textOf('chat-turn-text-0')).toBe('Remind me to call the dentist tomorrow at 5pm');
  });

  it('too long: the existing too-long line, with no Retry', async () => {
    jest.spyOn(captureEndpoints, 'chatCapture').mockRejectedValue(new InputTooLargeError(2000));
    await openCapture();
    await say('Remind me to call the dentist tomorrow at 5pm');
    await waitFor(() => expect(screen.queryByTestId('capture-error-message')).not.toBeNull());
    expect(textOf('capture-error-message')).toBe(en.aiInputTooLong);
    expect(screen.queryByTestId('capture-retry')).toBeNull();
  });
});
