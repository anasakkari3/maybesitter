/**
 * Simulator pass 2026-10-24 (rules path): «بدي روح عالبنك بكرا», then «لازم
 * اتصل بسامي بعد بكرا», then both time questions answered with the chips under
 * the summary. The second «هيك فهمت» still asked «أي ساعة بدك «روح عالبنك»؟».
 *
 * The server was right when it spoke: at the second message neither point had
 * a time, and it asks about the first one still waiting. The answers went
 * through `/capture/clarify`, which changes the proposal and says nothing, so
 * the reply's words stayed — asking for what the list already had.
 *
 * Which point a reply asks about is not read from its words: the server always
 * asks about the first point of the proposal it answered with that still needs
 * clarification (`chatReply` `itemAskingForTime`). Once that point no longer
 * waits, the reply says what the server says over such a list: «هيك فهمت لحد
 * هلّق.» while another question waits under it, «هيك فهمت. شوف القائمة…» when
 * none does — and the transcript keeps that after the save.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CaptureChatAnswer, CaptureProposal } from '../../../api/schemas/capture';
import { captureReducer, initialCaptureState, settledReply, type CaptureEvent } from '../captureMachine';
import * as captureEndpoints from '../../../api/endpoints/capture';
import { resetAuthForTests } from '../../../api/auth';
import { chatServer } from '../../../testing/captureChat';
import { openCapture, prepareRoot, say, type RootHarness } from '../../../__acceptance__/m2a/harness';
import ar from '../../../i18n/locales/ar.json';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'UTC' }]),
  getLocales: jest.fn(() => [{ languageCode: 'ar', languageTag: 'ar', textDirection: 'rtl' }]),
}));

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const TOMORROW = day(1);
const DAY_AFTER = day(2);

/** What the server's rules reply over these lists (`chatReply` templates). */
const ASKS_BANK = 'هيك فهمت لحد هلّق. أي ساعة بدك «روح عالبنك»؟';
const BANK_QUESTION = 'أي ساعة بدك «روح عالبنك»؟';

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
  version: 'v1', proposalId: 'p-1', revision: 1, status: 'needs_clarification', seeds: [],
  items: [bank],
  understood: [{ kind: 'commitment', itemId: 'bank', text: 'روح عالبنك' }],
} as unknown as CaptureProposal;
const both = {
  ...first, proposalId: 'p-2',
  items: [bank, sami],
  understood: [{ kind: 'commitment', itemId: 'bank', text: 'روح عالبنك' }, { kind: 'commitment', itemId: 'sami', text: 'اتصل بسامي' }],
} as unknown as CaptureProposal;
const bankAnswered = { ...both, items: [settled(bank, '09:30'), sami] } as unknown as CaptureProposal;
const bothAnswered = { ...both, status: 'proposed', items: [settled(bank, '09:30'), settled(sami, '13:00')] } as unknown as CaptureProposal;

/** The newest reply's words, as the bubble shows and a screen reader says them. */
const newestReplyWords = () => String(screen.getByTestId('chat-turn-assistant-3-words').props.accessibilityLabel);

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
    { reply: () => ASKS_BANK },
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

describe('sim 2026-10-24: an answered question is not asked again by the reply above it', () => {
  it('the second «هيك فهمت» stops asking for the bank’s hour once both hours are answered', async () => {
    const clarify = await twoMessages();
    // Before any answer the reply asks, as the server said it.
    expect(newestReplyWords()).toBe(ASKS_BANK);
    expect(screen.getByTestId('clarify-question').props.children).toContain('روح عالبنك');

    // The bank's hour: the reply no longer asks it; Sami's question waits under it.
    await act(async () => { await fireEvent.press(screen.getByTestId('clarify-option-bank-morning')); });
    await waitFor(() => expect(clarify).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('clarify-question').props.children).toContain('اتصل بسامي'));
    expect(newestReplyWords()).toBe(ar.chatUnderstoodSoFar);
    expect(newestReplyWords()).not.toContain(BANK_QUESTION);

    // Sami's hour: nothing waits, and the reply says to check the list.
    await act(async () => { await fireEvent.press(screen.getByTestId('clarify-option-sami-morning')); });
    await waitFor(() => expect(clarify).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('clarify-sheet')).toBeNull());
    expect(newestReplyWords()).toBe(ar.chatUnderstoodCheckList);
    expect(newestReplyWords()).not.toContain(BANK_QUESTION);

    // The first reply is the conversation's history: it asked, then.
    expect(screen.getByTestId('chat-turn-assistant-1').props.accessibilityLabel).toBe(ASKS_BANK);
    // And the answers went to the right points of the proposal on screen.
    expect(clarify.mock.calls[0]![0]).toMatchObject({ proposalId: 'p-2', itemId: 'bank', optionId: 'bank-morning' });
    expect(clarify.mock.calls[1]![0]).toMatchObject({ proposalId: 'p-2', itemId: 'sami', optionId: 'sami-morning' });
  });

  it('after the save, the transcript keeps the settled line, not the old question', async () => {
    const clarify = await twoMessages();
    await act(async () => { await fireEvent.press(screen.getByTestId('clarify-option-bank-morning')); });
    await waitFor(() => expect(screen.getByTestId('clarify-question').props.children).toContain('اتصل بسامي'));
    await act(async () => { await fireEvent.press(screen.getByTestId('clarify-option-sami-morning')); });
    await waitFor(() => expect(clarify).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('clarify-sheet')).toBeNull());

    jest.spyOn(captureEndpoints, 'confirmCapture').mockResolvedValue({
      success: true, replayed: false, failed: [],
      persisted: bothAnswered.items.map((item, index) => ({ itemId: item.itemId, commitmentId: `c-${index}`, title: item.title, resolvedTime: item.resolvedTime })),
    } as never);
    await act(async () => { await fireEvent.press(screen.getByTestId('understood-confirm')); });
    await waitFor(() => expect(screen.queryByTestId('review-confirm')).not.toBeNull());
    await act(async () => { await fireEvent.press(screen.getByTestId('review-confirm')); });
    await waitFor(() => expect(screen.queryByTestId('chat-saved-1')).not.toBeNull());

    expect(screen.getByTestId('chat-turn-assistant-3').props.accessibilityLabel).toBe(ar.chatUnderstoodCheckList);
    expect(screen.getByTestId('chat-turn-assistant-1').props.accessibilityLabel).toBe(ASKS_BANK);
  });

  it('a reply over a list whose question is still waiting is shown as the server said it', async () => {
    await twoMessages();
    expect(newestReplyWords()).toBe(ASKS_BANK);
    expect(screen.queryByText(ar.chatUnderstoodCheckList)).toBeNull();
  });
});

describe('settledReply: which reply stops asking, by the proposal and never by its words', () => {
  const answer = (proposal: CaptureProposal, reply = ASKS_BANK): CaptureChatAnswer => ({
    conversationId: '00000000-0000-4000-8000-000000000001', reply, engine: 'rules', proposal,
    turns: [{ role: 'user', text: 'بدي روح عالبنك بكرا' }, { role: 'assistant', text: reply }],
  });
  const run = (...events: CaptureEvent[]) => events.reduce(captureReducer, initialCaptureState());

  it('asks about the first point still waiting, and settles only when that point is answered', () => {
    const asked = run({ type: 'chatAnswered', answer: answer(both) });
    expect(asked.replyAsks).toEqual({ proposalId: 'p-2', itemId: 'bank' });
    expect(settledReply(asked)).toBeNull();
    // Sami answered first: the reply asked about the bank, which still waits.
    const samiFirst = captureReducer(asked, { type: 'clarified', proposal: { ...both, items: [bank, settled(sami, '13:00')] } as unknown as CaptureProposal });
    expect(settledReply(samiFirst)).toBeNull();
    expect(settledReply(captureReducer(asked, { type: 'clarified', proposal: bankAnswered }))).toBe('soFar');
    expect(settledReply(captureReducer(asked, { type: 'clarified', proposal: bothAnswered }))).toBe('list');
  });

  it('a time set by hand on the card settles it as the chips do', () => {
    const asked = run({ type: 'chatAnswered', answer: answer(first) });
    const edited = captureReducer(asked, { type: 'editItem', itemId: 'bank', edit: { title: 'روح عالبنك', localDateTime: `${TOMORROW}T09:30` } });
    expect(settledReply(edited)).toBe('list');
  });

  it('a reply with no question in it stays as the server said it', () => {
    const refused = run({ type: 'chatAnswered', answer: answer(first, 'ما قدرت أطبّق التعديل هلّق — عدّله من الكرت تحت.') });
    expect(settledReply(captureReducer(refused, { type: 'clarified', proposal: { ...first, items: [settled(bank, '09:30')] } as unknown as CaptureProposal }))).toBeNull();
  });

  it('a new answer asks afresh; a list with nothing to ask asks nothing', () => {
    const asked = run({ type: 'chatAnswered', answer: answer(first) });
    const next = captureReducer(asked, { type: 'chatAnswered', answer: answer(bothAnswered, 'هيك فهمت. شوف القائمة وإذا كلها تمام أكّدها.') });
    expect(next.replyAsks).toBeNull();
    expect(settledReply(next)).toBeNull();
    // Another proposal's answer never settles this reply.
    expect(settledReply({ ...asked, proposal: { ...bothAnswered, proposalId: 'p-other' } as unknown as CaptureProposal })).toBeNull();
  });
});
