import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { resetAuthForTests } from '../../api/auth';
import * as captureEndpoints from '../../api/endpoints/capture';
import type { CaptureChatAnswer, CaptureProposal } from '../../api/schemas/capture';
import { ExpoSpeechCaptureService } from '../../features/capture/voice/expoSpeechCaptureService';
import {
  CONVERSATION_ID,
  ITEM_ID,
  answerFor,
  commitmentProposal,
  lastCall,
  openCapture,
  prepareRoot,
  press,
  say,
  type RootHarness,
} from './harness';

jest.mock('../../features/capture/voice/speechService', () => {
  let callbacks: { onFinal?: (...args: unknown[]) => void; onStatus?: (status: string) => void } = {};
  const service = {
    locale: 'en-US',
    status: 'idle',
    start: jest.fn(async (next: typeof callbacks) => {
      callbacks = next;
      service.status = 'listening';
      callbacks.onStatus?.('listening');
    }),
    stop: jest.fn(async () => {}),
    cancel: jest.fn(async () => {}),
    finish(primary: string, alternatives: string[]) {
      callbacks.onFinal?.(primary, alternatives);
      service.status = 'reviewingTranscript';
      callbacks.onStatus?.('reviewingTranscript');
    },
  };
  return {
    SpeechEventBridge: () => null,
    createSpeechCaptureService: () => service,
    speechLanguageForTag: () => 'en',
    __m2bSpeech: service,
  };
});

function speechMock() {
  return jest.requireMock('../../features/capture/voice/speechService') as {
    __m2bSpeech: {
      start: ReturnType<typeof jest.fn>;
      finish(primary: string, alternatives: string[]): void;
    };
  };
}

let harness: RootHarness;

beforeEach(async () => {
  harness = await prepareRoot('en');
  speechMock().__m2bSpeech.start.mockClear();
});

afterEach(async () => {
  await cleanup();
  harness.client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});

async function dictate(primary: string, alternatives: string[]): Promise<void> {
  await waitFor(() => expect(screen.queryByTestId('voice-button')).not.toBeNull());
  await press('voice-button');
  await waitFor(() => expect(speechMock().__m2bSpeech.start).toHaveBeenCalled());
  await act(async () => {
    speechMock().__m2bSpeech.finish(primary, alternatives);
  });
}

function chatThatReturnsNothing() {
  return jest.spyOn(captureEndpoints, 'chatCapture').mockImplementation((async (raw: unknown) => {
    const input = raw as { conversationId?: string | null; message: string };
    return answerFor(null, input.message, input.conversationId ?? CONVERSATION_ID);
  }) as never);
}

describe('M2b dictated alternatives', () => {
  it('A1 alternatives: asks the native recognizer for multiple alternatives', async () => {
    const start = jest.fn();
    const native = {
      requestPermissionsAsync: async () => ({ granted: true }),
      getSupportedLocales: async () => ({ locales: ['en-US'], installedLocales: ['en-US'] }),
      start,
      stop: jest.fn(),
      abort: jest.fn(),
    };
    const service = new ExpoSpeechCaptureService(native, () => () => {}, () => 'en');
    await service.start({});
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ maxAlternatives: expect.any(Number) }));
  });

  it('A1 alternatives: requests alternatives and shows at most three de-duplicated whole-draft chips for an untouched dictation', async () => {
    await openCapture(harness);
    await fireEvent.changeText(screen.getByTestId('capture-input'), 'Before');
    await dictate('call Dana', ['call Dina', 'call Dina', 'call Deena', 'call Dena']);

    const chips = screen.getAllByTestId(/^capture-alternative-/);
    expect(chips).toHaveLength(3);
    const alternatives = chips.map((chip) => String(chip.props.accessibilityLabel ?? chip.props.children));
    expect(new Set(alternatives).size).toBe(alternatives.length);
    expect(alternatives.every((value) => value.includes('Before'))).toBe(true);
  });

  it('A1 alternatives: tapping a chip replaces the draft, never sends, and the later request is spoken with only the visible words', async () => {
    const chat = chatThatReturnsNothing();
    await openCapture(harness);
    await dictate('call Dana', ['call Dina']);

    await press('capture-alternative-1');
    expect(chat).not.toHaveBeenCalled();
    expect(screen.getByTestId('capture-input').props.value).toBe('call Dina');

    await press('capture-analyze');
    await waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
    expect(lastCall(chat)).toEqual(expect.objectContaining({ message: 'call Dina', spoken: true }));
    expect(JSON.stringify(lastCall(chat))).not.toContain('call Dana');
  });

  it('A1 alternatives: a manual edit clears hidden alternatives but keeps spoken true and never sends deleted or alternate words', async () => {
    const chat = chatThatReturnsNothing();
    await openCapture(harness);
    await dictate('buy milk and bread', ['buy milk and bred']);
    expect(screen.queryByTestId('capture-alternative-1')).not.toBeNull();

    await fireEvent.changeText(screen.getByTestId('capture-input'), 'buy milk');
    expect(screen.queryByTestId('capture-alternative-1')).toBeNull();
    await press('capture-analyze');
    await waitFor(() => expect(chat).toHaveBeenCalledTimes(1));

    const request = lastCall(chat);
    expect(request).toEqual(expect.objectContaining({ message: 'buy milk', spoken: true }));
    expect(JSON.stringify(request)).not.toMatch(/bread|bred|alternative/i);
  });

  it('A1 alternatives: sending and then starting a new dictation clears the previous alternatives', async () => {
    chatThatReturnsNothing();
    await openCapture(harness);
    await dictate('first words', ['first worlds']);
    expect(screen.queryByTestId('capture-alternative-1')).not.toBeNull();
    await press('capture-analyze');
    await waitFor(() => expect(screen.queryByTestId('chat-turn-assistant-1')).not.toBeNull());
    expect(screen.queryByTestId('capture-alternative-1')).toBeNull();

    await dictate('second words', ['second worlds']);
    expect(screen.getByTestId('capture-input').props.value).toBe('second words');
    expect(screen.queryByText('first worlds')).toBeNull();
  });
});

describe('M2b correction rejection', () => {
  it('A2 corrections: shows two correction lines and rejecting one sends only its id while the other remains', async () => {
    const initial = commitmentProposal({
      items: [{
        ...commitmentProposal().items[0]!,
        title: 'Leave and leave now',
        corrections: [
          { id: 'correction-1', from: 'leaf', to: 'leave' },
          { id: 'correction-2', from: 'later', to: 'leave' },
        ],
      }],
      understood: [{ kind: 'commitment', itemId: ITEM_ID, text: 'Leave and leave now' }],
    });
    const updated: CaptureProposal = {
      ...initial,
      revision: 8,
      items: [{
        ...initial.items[0]!,
        title: 'Leaf and leave now',
        corrections: [{ id: 'correction-2', from: 'later', to: 'leave' }],
      }],
      understood: [{ kind: 'commitment', itemId: ITEM_ID, text: 'Leaf and leave now' }],
    };
    const chat = jest.spyOn(captureEndpoints, 'chatCapture')
      .mockResolvedValueOnce(answerFor(initial) as never)
      .mockResolvedValueOnce(answerFor(updated) as never);

    await openCapture(harness);
    await say('Leaf and later now');
    await waitFor(() => expect(screen.queryByTestId('understood-correction-correction-1')).not.toBeNull());
    expect(screen.queryByTestId('understood-correction-correction-2')).not.toBeNull();

    await press('understood-correction-reject-correction-1');
    await waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(lastCall(chat)).toEqual(expect.objectContaining({
      conversationId: CONVERSATION_ID,
      edit: {
        proposalId: initial.proposalId,
        revision: 7,
        target: { itemId: ITEM_ID },
        change: { rejectCorrectionIds: ['correction-1'] },
      },
    }));
    expect(screen.queryByTestId('understood-correction-correction-1')).toBeNull();
    expect(screen.queryByTestId('understood-correction-correction-2')).not.toBeNull();
  });
});
