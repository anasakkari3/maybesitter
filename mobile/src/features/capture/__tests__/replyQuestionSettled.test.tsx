/**
 * #802: `/capture/clarify` updates the proposal without adding a chat turn.
 * The assistant turn keeps its arrival words — announced once, on both
 * platforms — and only its structured trailing question is retired once that
 * item is settled, outside the live region.
 */
import { AccessibilityInfo, Platform } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CaptureProposal } from '../../../api/schemas/capture';
import * as captureEndpoints from '../../../api/endpoints/capture';
import { resetAuthForTests } from '../../../api/auth';
import { chatServer } from '../../../testing/captureChat';
import { openCapture, prepareRoot, say, type RootHarness } from '../../../__acceptance__/m2a/harness';
import { presentChatReply } from '../captureMachine';
import ar from '../../../i18n/locales/ar.json';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'UTC' }]),
  getLocales: jest.fn(() => [{ languageCode: 'ar', languageTag: 'ar', textDirection: 'rtl' }]),
}));

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const TOMORROW = day(1);
const DAY_AFTER = day(2);
const QUESTION = 'أي ساعة بدك «روح عالبنك»؟';
const ACKNOWLEDGEMENT = 'غيّرت الدكتور لـ 6.';
const SECOND_REPLY = `${ACKNOWLEDGEMENT} ${QUESTION}`;

function asking(itemId: string, title: string, date: string) {
  return {
    itemId, title, resolvedTime: null, resolvedDate: date, needsClarification: true,
    clarification: {
      questionId: `q-${itemId}`, field: 'time', questionKey: 'ask_time', params: { title, date },
      options: [
        { optionId: `${itemId}-morning`, labelKey: 'freeSlot', labelParams: { localDate: date, localTime: '09:30' }, value: { localDate: date, localTime: '09:30' } },
        { optionId: `${itemId}-none`, labelKey: 'noTime', labelParams: {}, value: {} },
      ],
      allowFreeText: true,
    },
  };
}

function settled(item: ReturnType<typeof asking>, time: string) {
  return { ...item, needsClarification: false, clarification: null, resolvedTime: `${item.resolvedDate}T${time}:00.000Z` };
}

const bank = asking('bank', 'روح عالبنك', TOMORROW);
const sami = asking('sami', 'اتصل بسامي', DAY_AFTER);
const first = {
  version: 'v1', proposalId: 'p-chat', revision: 1, status: 'needs_clarification', seeds: [], items: [bank],
  understood: [{ kind: 'commitment', itemId: 'bank', text: 'روح عالبنك' }],
} as unknown as CaptureProposal;
const both = {
  ...first, items: [bank, sami],
  understood: [{ kind: 'commitment', itemId: 'bank', text: 'روح عالبنك' }, { kind: 'commitment', itemId: 'sami', text: 'اتصل بسامي' }],
} as unknown as CaptureProposal;
const bankAnswered = { ...both, items: [settled(bank, '09:30'), sami] } as unknown as CaptureProposal;
const bothAnswered = { ...both, status: 'proposed', items: [settled(bank, '09:30'), settled(sami, '13:00')] } as unknown as CaptureProposal;

let harness: RootHarness;
beforeEach(async () => { harness = await prepareRoot('ar'); });
afterEach(async () => {
  await cleanup();
  harness.client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});

async function twoMessages() {
  const proposals = [first, both];
  jest.spyOn(captureEndpoints, 'chatCapture').mockImplementation(chatServer(
    (_message, call) => proposals[call] ?? null,
    {
      reply: (_message, _proposal, call) => call === 0 ? `${ar.chatUnderstoodSoFar} ${QUESTION}` : SECOND_REPLY,
      asked: () => ({ itemId: 'bank', text: QUESTION }),
    },
  ) as never);
  const clarify = jest.spyOn(captureEndpoints, 'clarifyCapture')
    .mockResolvedValueOnce(bankAnswered as never)
    .mockResolvedValueOnce(bothAnswered as never);
  await openCapture(harness);
  await say('بدي روح عالبنك بكرا');
  await waitFor(() => expect(screen.queryByTestId('understood-confirm')).not.toBeNull());
  await say('لازم اتصل بسامي بعد بكرا');
  await waitFor(() => expect(screen.queryByTestId('chat-turn-assistant-3-words')).not.toBeNull());
  return clarify;
}

describe('#802: only the settled question segment retires', () => {
  it('keeps the acknowledgement after both chip answers and retires the bank question from current and older turns', async () => {
    const clarify = await twoMessages();
    expect(screen.getByTestId('chat-turn-assistant-3-words').props.accessibilityLabel).toBe(SECOND_REPLY);
    expect(screen.queryByTestId('chat-turn-assistant-3-question')).not.toBeNull();

    await act(async () => { await fireEvent.press(screen.getByTestId('clarify-option-bank-morning')); });
    await waitFor(() => expect(clarify).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('clarify-question').props.children).toContain('اتصل بسامي'));
    expect(screen.getByTestId('chat-turn-assistant-3-words').props.accessibilityLabel).toBe(ACKNOWLEDGEMENT);
    expect(screen.queryByTestId('chat-turn-assistant-3-question')).toBeNull();
    expect(screen.queryByTestId('chat-turn-assistant-1-question')).toBeNull();
    expect(screen.getByTestId('chat-turn-assistant-1').props.accessibilityLabel).toBe(ar.chatUnderstoodSoFar);

    await act(async () => { await fireEvent.press(screen.getByTestId('clarify-option-sami-morning')); });
    await waitFor(() => expect(clarify).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('clarify-sheet')).toBeNull());
    expect(screen.getByTestId('chat-turn-assistant-3-words').props.accessibilityLabel).toBe(ACKNOWLEDGEMENT);
  });

  for (const os of ['ios', 'android'] as const) {
    it(`${os}: the reply is announced once in full, nothing of it is in the live region, and retiring the question announces nothing`, async () => {
      jest.replaceProperty(Platform, 'OS', os);
      const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
      announce.mockClear();
      await twoMessages();
      const live = screen.getByTestId('chat-live', { includeHiddenElements: true });
      expect(within(live).queryAllByText(/./, { includeHiddenElements: true })).toHaveLength(0);
      expect(within(live).queryByTestId('chat-turn-assistant-3-words', { includeHiddenElements: true })).toBeNull();
      const childCount = live.children.length;
      expect(announce.mock.calls.filter(([said]) => said === SECOND_REPLY)).toHaveLength(1);
      const calls = announce.mock.calls.length;

      await act(async () => { await fireEvent.press(screen.getByTestId('clarify-option-bank-morning')); });
      await waitFor(() => expect(screen.queryByTestId('chat-turn-assistant-3-question')).toBeNull());
      expect(screen.getByTestId('chat-live', { includeHiddenElements: true })).toBe(live);
      expect(live.children).toHaveLength(childCount);
      expect(announce.mock.calls.length).toBe(calls);
    });
  }
});

describe('presentChatReply guards', () => {
  const turn = { role: 'assistant' as const, text: SECOND_REPLY, asked: { itemId: 'bank', text: QUESTION } };
  const copy = { soFar: ar.chatUnderstoodSoFar, list: ar.chatUnderstoodCheckList };

  it('keeps the question while its item still asks it', () => {
    expect(presentChatReply(turn, both, copy)).toEqual({
      text: ACKNOWLEDGEMENT, question: QUESTION, announcementText: SECOND_REPLY,
    });
  });

  it('retires the question when its item was removed', () => {
    const removed = { ...both, items: [sami] } as unknown as CaptureProposal;
    expect(presentChatReply(turn, removed, copy)).toEqual({ text: ACKNOWLEDGEMENT, announcementText: SECOND_REPLY });
  });

  it('draws an older turn without asked unchanged', () => {
    const old = { role: 'assistant' as const, text: SECOND_REPLY };
    expect(presentChatReply(old, bothAnswered, copy)).toEqual({ text: SECOND_REPLY, announcementText: SECOND_REPLY });
  });

  it('uses the existing settled line when the question was the whole reply', () => {
    const only = { role: 'assistant' as const, text: QUESTION, asked: { itemId: 'bank', text: QUESTION } };
    expect(presentChatReply(only, bankAnswered, copy)).toEqual({ text: ar.chatUnderstoodSoFar, announcementText: QUESTION });
    expect(presentChatReply(only, bothAnswered, copy)).toEqual({ text: ar.chatUnderstoodCheckList, announcementText: QUESTION });
  });
});
