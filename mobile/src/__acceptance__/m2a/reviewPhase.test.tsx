/** M2a · Task A · criterion 2 — proposal-id keyed understood/review phase. */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CaptureProposal } from '../../api/schemas/capture';
import * as captureEndpoints from '../../api/endpoints/capture';
import { resetAuthForTests } from '../../api/auth';
import { chatServer } from '../../testing/captureChat';
import { openCapture, prepareRoot, say, type RootHarness } from './harness';

const START = new Date(Date.now() + 72 * 3_600_000).toISOString();

function ready(proposalId: string, itemId: string, text: string): CaptureProposal {
  return {
    version: 'v1', proposalId, status: 'proposed', seeds: [],
    items: [{ itemId, title: `${text} task`, resolvedTime: START, needsClarification: false }],
    understood: [{ kind: 'commitment', itemId, text }],
  };
}

function needsTime(): CaptureProposal {
  return {
    version: 'v1', proposalId: 'proposal-clarify', status: 'needs_clarification', seeds: [],
    items: [{
      itemId: 'clarify-item', title: 'Call Dana', resolvedTime: null, needsClarification: true,
      clarification: {
        questionId: 'question-time', field: 'time', questionKey: 'ask_time', params: { title: 'Call Dana' },
        options: [{ optionId: 'evening', labelKey: 'evening', labelParams: {}, value: { localTime: '19:00', localDate: '2030-01-08' } }],
        allowFreeText: true,
      },
    }],
    understood: [{ kind: 'commitment', itemId: 'clarify-item', text: 'Remember to call Dana' }],
  };
}

let harness: RootHarness;

beforeEach(async () => { harness = await prepareRoot('en'); });

afterEach(async () => {
  await cleanup();
  harness.client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});

function understoodPrimary(pointText: string) {
  const excluded = new Set([
    'capture-cancel', 'review-back', 'chat-more', 'capture-ai-disclosure-toggle',
    'capture-paste', 'capture-analyze', 'voice-button', 'voice-language',
  ]);
  const candidates = screen.getAllByRole('button').filter(button => {
    const testId = String(button.props.testID ?? '');
    if (excluded.has(testId) || testId.startsWith('clarify-')) return false;
    return !String(button.props.accessibilityLabel ?? '').includes(pointText);
  });
  expect(candidates).toHaveLength(1);
  return candidates[0]!;
}

async function firstAnswer(proposal: CaptureProposal): Promise<void> {
  jest.spyOn(captureEndpoints, 'chatCapture').mockImplementation(chatServer(() => proposal) as never);
  await openCapture(harness);
  await say('first message');
  await waitFor(() => expect(screen.queryByText(proposal.understood![0]!.text)).not.toBeNull());
}

describe('proposal phase transitions', () => {
  it('A2 reducer phase: the primary action opens review and Back returns to the understood message for the same proposal', async () => {
    const proposal = ready('proposal-one', 'item-one', 'Call the dentist');
    await firstAnswer(proposal);

    await act(async () => { await fireEvent.press(understoodPrimary('Call the dentist')); });
    await waitFor(() => expect(screen.queryByTestId('review-card-item-one')).not.toBeNull());
    await act(async () => { await fireEvent.press(screen.getByTestId('review-back')); });

    await waitFor(() => expect(screen.queryByText('Call the dentist')).not.toBeNull());
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByTestId('review-card-item-one')).toBeNull();
  });

  it('A2 reducer phase: a new answer with a new proposal id shows its understood message again', async () => {
    const first = ready('proposal-one', 'item-one', 'Call the dentist');
    const second = ready('proposal-two', 'item-two', 'Buy milk');
    const chat = jest.spyOn(captureEndpoints, 'chatCapture');
    const server = chatServer((_message, call) => call === 0 ? first : second);
    chat.mockImplementation(server as never);
    await openCapture(harness);
    await say('first message');
    await waitFor(() => expect(screen.queryByText('Call the dentist')).not.toBeNull());
    await act(async () => { await fireEvent.press(understoodPrimary('Call the dentist')); });
    await waitFor(() => expect(screen.queryByTestId('review-card-item-one')).not.toBeNull());

    await say('and buy milk');
    await waitFor(() => expect(screen.queryByText('Buy milk')).not.toBeNull());
    expect(screen.queryByTestId('review-card-item-two')).toBeNull();
  });

  it('A2 reducer phase: a clarification response with the same proposal id keeps review open', async () => {
    const initial = needsTime();
    const settled: CaptureProposal = {
      ...initial,
      status: 'proposed',
      items: [{ itemId: 'clarify-item', title: 'Call Dana', resolvedTime: '2030-01-08T19:00:00.000Z', needsClarification: false }],
    };
    jest.spyOn(captureEndpoints, 'clarifyCapture').mockResolvedValue(settled as never);
    await firstAnswer(initial);
    expect(screen.queryByTestId('clarify-option-evening')).not.toBeNull();
    await act(async () => { await fireEvent.press(understoodPrimary('Remember to call Dana')); });
    await waitFor(() => expect(screen.queryByTestId('clarify-option-evening')).not.toBeNull());

    await act(async () => { await fireEvent.press(screen.getByTestId('clarify-option-evening')); });
    await waitFor(() => expect(screen.queryByTestId('review-card-clarify-item')).not.toBeNull());
    expect(screen.queryByText('Call Dana')).not.toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
  });
});
