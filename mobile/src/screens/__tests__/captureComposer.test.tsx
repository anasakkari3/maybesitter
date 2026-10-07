/**
 * The composer on a phone with a keyboard and a mic (owner's first iPhone run).
 *
 * Two defects, each asserted from its literal repro:
 *
 * - Dictation replaced the whole field. Typing "A" then dictating "B c" left
 *   "B c". It must append to what was there when the dictation started, and a
 *   second dictation must append again.
 * - The keyboard hid the text and the Analyze button: Analyze was the last
 *   child of the scroll content, and the input grew without limit. Analyze and
 *   the mic now sit in a footer outside the ScrollView (inside the
 *   KeyboardAvoidingView), and the input has a maxHeight and scrolls itself.
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { CaptureProvider } from '../../features/capture/CaptureProvider';
import { LANGUAGE_STORAGE_KEY } from '../../i18n/language';
import en from '../../i18n/locales/en.json';
import type {
  SpeechCaptureCallbacks,
  SpeechCaptureService,
  SpeechStatus,
} from '../../features/capture/voice/SpeechCaptureService';
import { CaptureScreen } from '../CaptureScreen';

/** A recogniser the test speaks through. */
class FakeSpeech implements SpeechCaptureService {
  readonly locale = 'en-US';
  status: SpeechStatus = 'idle';
  started = 0;
  private callbacks: SpeechCaptureCallbacks = {};
  async start(callbacks: SpeechCaptureCallbacks): Promise<void> {
    this.started += 1;
    this.callbacks = callbacks;
    this.status = 'listening';
    callbacks.onStatus?.('listening');
  }
  async stop(): Promise<void> {
    this.status = 'reviewingTranscript';
    this.callbacks.onStatus?.('reviewingTranscript');
  }
  // As the real recogniser does (expoSpeechCaptureService): a cancelled
  // dictation is idle again at once.
  async cancel(): Promise<void> {
    if (this.status === 'listening') this.status = 'idle';
  }
  partial(text: string) { this.callbacks.onPartial?.(text); }
  final(text: string) { this.callbacks.onFinal?.(text); }
}

const mockSpeech = new FakeSpeech();

jest.mock('../../features/capture/voice/speechService', () => ({
  createSpeechCaptureService: () => mockSpeech,
  SpeechEventBridge: () => null,
}));

// The reader's text size, per test: 1 unless a test is about large text.
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const useWindowDimensions = require('react-native/Libraries/Utilities/useWindowDimensions')
  .default as jest.Mock<() => { width: number; height: number; scale: number; fontScale: number }>;

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function flat(style: unknown): Record<string, unknown> {
  return StyleSheet.flatten(style) as Record<string, unknown>;
}

let client: QueryClient;

beforeEach(async () => {
  useWindowDimensions.mockReturnValue({ width: 390, height: 844, scale: 3, fontScale: 1 });
  mockSpeech.started = 0;
  mockSpeech.status = 'idle';
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
});

afterEach(async () => {
  client.clear();
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});

async function showComposer() {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <QueryClientProvider client={client}>
        <AuthProvider>
          <AppProvider>
            <CaptureProvider>
              <CaptureScreen />
            </CaptureProvider>
          </AppProvider>
        </AuthProvider>
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('capture-input')).not.toBeNull());
}

const field = () => screen.getByTestId('capture-input').props.value as string;

async function dictate(partials: string[], final: string) {
  await fireEvent.press(screen.getByTestId('voice-button'));
  await waitFor(() => expect(mockSpeech.status).toBe('listening'));
  for (const text of partials) {
    await React.act(async () => { mockSpeech.partial(text); });
  }
  await React.act(async () => { mockSpeech.final(final); });
  await fireEvent.press(screen.getByTestId('voice-button'));
}

describe('dictation adds to the field', () => {
  it('type "A", dictate "B c" → "A B c"; partials replace only this dictation\'s words', async () => {
    await showComposer();
    await fireEvent.changeText(screen.getByTestId('capture-input'), 'A');

    await fireEvent.press(screen.getByTestId('voice-button'));
    await waitFor(() => expect(mockSpeech.status).toBe('listening'));
    await React.act(async () => { mockSpeech.partial('B'); });
    expect(field()).toBe('A B');
    await React.act(async () => { mockSpeech.partial('B c'); });
    expect(field()).toBe('A B c');
    await React.act(async () => { mockSpeech.final('B c'); });
    expect(field()).toBe('A B c');
  });

  it('a second dictation appends again', async () => {
    await showComposer();
    await fireEvent.changeText(screen.getByTestId('capture-input'), 'A');
    await dictate(['B', 'B c'], 'B c');
    await dictate(['d'], 'd e');
    expect(field()).toBe('A B c d e');
    expect(mockSpeech.started).toBe(2);
  });

  it('into an empty field, the words are the whole field', async () => {
    await showComposer();
    await dictate(['call'], 'call Dana');
    expect(field()).toBe('call Dana');
  });
});

describe('the listening panel (Stitch 03b)', () => {
  it('says it is listening, keeps the field, and «إلغاء» ends the dictation with the field as it was before it', async () => {
    await showComposer();
    await fireEvent.changeText(screen.getByTestId('capture-input'), 'A');
    expect(screen.queryByTestId('voice-listening-panel')).toBeNull();

    await fireEvent.press(screen.getByTestId('voice-button'));
    await waitFor(() => expect(screen.queryByTestId('voice-listening-panel')).not.toBeNull());
    expect(screen.getByTestId('voice-listening-title').props.children).toBe(en.chatListening);
    expect(screen.getByTestId('voice-listening-note').props.children).toBe(en.voiceListening);
    // The partial transcript is still visible in the field while listening.
    await React.act(async () => { mockSpeech.partial('B c'); });
    expect(field()).toBe('A B c');
    // The mic is the stop control, and Cancel is its own 44-point button.
    expect(screen.getByTestId('voice-stop-glyph')).toBeTruthy();
    const cancel = screen.getByTestId('voice-cancel');
    expect(cancel.props.accessibilityLabel).toBe(en.cancel);
    expect(flat(cancel.props.style).minHeight as number).toBeGreaterThanOrEqual(44);

    await fireEvent.press(cancel);
    await waitFor(() => expect(screen.queryByTestId('voice-listening-panel')).toBeNull());
    expect(field()).toBe('A');
    // A late word from the cancelled dictation writes nothing.
    await React.act(async () => { mockSpeech.final('B c d'); });
    expect(field()).toBe('A');
  });
});

describe('the chat composer remains above the keyboard', () => {
  it('keeps the native field, send action, and microphone outside the conversation in AvoidKeyboard', async () => {
    await showComposer();
    await fireEvent.changeText(screen.getByTestId('capture-input'), 'call Dana');
    const conversation = within(screen.getByTestId('capture-scroll'));
    const footer = within(screen.getByTestId('chat-composer'));
    for (const id of ['capture-input', 'capture-analyze', 'voice-button']) {
      expect(conversation.queryByTestId(id)).toBeNull();
      expect(footer.getByTestId(id)).toBeTruthy();
    }
    expect(within(screen.getByTestId('capture-kav')).getByTestId('chat-composer')).toBeTruthy();
    expect(flat(screen.getByTestId('chat-composer-row').props.style).flexDirection).toBe('row');
  });

  it.each([1, 1.35, 1.64, 3.12])('at fontScale %s a long draft scrolls inside a bounded native field', async (fontScale) => {
    useWindowDimensions.mockReturnValue({ width: 390, height: 844, scale: 3, fontScale });
    await showComposer();
    const before = flat(screen.getByTestId('capture-input').props.style);
    expect(typeof before.minHeight).toBe('number');
    expect(typeof before.maxHeight).toBe('number');
    expect(before.maxHeight as number).toBeGreaterThanOrEqual(before.minHeight as number);
    // This footer does not borrow its height from conversation layout events.
    // Native input scrolling contains a long draft without expanding the footer.
    await fireEvent.changeText(screen.getByTestId('capture-input'), 'A long line\n'.repeat(30));
    await fireEvent(screen.getByTestId('capture-input'), 'contentSizeChange', {
      nativeEvent: { contentSize: { width: 200, height: 1600 } },
    });
    const input = screen.getByTestId('capture-input');
    expect(flat(input.props.style).maxHeight).toBe(before.maxHeight);
    expect(input.props.multiline).toBe(true);
    expect(input.props.scrollEnabled).toBe(true);
    expect(within(screen.getByTestId('capture-scroll')).queryByTestId('capture-input')).toBeNull();
    expect(within(screen.getByTestId('chat-composer')).getByTestId('capture-input')).toBeTruthy();
  });

  it('the discard question removes the field and footer while retaining the conversation region', async () => {
    await showComposer();
    await fireEvent.changeText(screen.getByTestId('capture-input'), 'call Dana');
    // The discard question comes from «ابدأ من جديد» (M2b): Back keeps the draft.
    await fireEvent.press(screen.getByTestId('chat-more'));
    await fireEvent.press(screen.getByTestId('chat-menu-start-over'));
    await waitFor(() => expect(screen.getByTestId('capture-discard')).toBeTruthy());
    expect(screen.queryByTestId('capture-input')).toBeNull();
    expect(screen.queryByTestId('chat-composer')).toBeNull();
    expect(within(screen.getByTestId('capture-scroll')).getByTestId('capture-discard')).toBeTruthy();
  });
});

// At accessibility sizes, the header and speech-language chip can scroll away;
// only the bounded input row remains fixed above AvoidKeyboard's window overlap.
describe('accessible text sizes in the chat layout', () => {
  const atScale = (fontScale: number) =>
    useWindowDimensions.mockReturnValue({ width: 402, height: 874, scale: 3, fontScale });

  it.each([1, 1.12, 1.35])('at fontScale %s the header is fixed and the language chip stays in the composer', async (fontScale) => {
    atScale(fontScale);
    await showComposer();
    expect(within(screen.getByTestId('capture-scroll')).queryByTestId('chat-header')).toBeNull();
    expect(screen.getAllByTestId('chat-header')).toHaveLength(1);
    expect(within(screen.getByTestId('chat-composer')).getByTestId('voice-language')).toBeTruthy();
    expect(within(screen.getByTestId('chat-composer')).getByTestId('voice-button')).toBeTruthy();
  });

  it.each([1.64, 1.94, 2.35, 2.76, 3.12])('at fontScale %s the header and language chip scroll while the field stays pinned', async (fontScale) => {
    atScale(fontScale);
    await showComposer();
    await fireEvent.changeText(screen.getByTestId('capture-input'), 'call Dana');
    const conversation = within(screen.getByTestId('capture-scroll'));
    expect(conversation.getByTestId('chat-header')).toBeTruthy();
    expect(conversation.getByLabelText('Back')).toBeTruthy();
    expect(screen.getAllByTestId('chat-header')).toHaveLength(1);
    expect(conversation.getByTestId('voice-language')).toBeTruthy();
    const footer = within(screen.getByTestId('chat-composer'));
    expect(footer.queryByTestId('voice-language')).toBeNull();
    for (const id of ['capture-input', 'capture-analyze', 'voice-button']) {
      expect(footer.getByTestId(id)).toBeTruthy();
      expect(conversation.queryByTestId(id)).toBeNull();
    }
    expect(flat(screen.getByTestId('chat-composer-row').props.style).flexDirection).toBe('row');
  });

  it('the language chip still switches the dictation language from the conversation', async () => {
    atScale(3.12);
    await showComposer();
    const chip = within(screen.getByTestId('capture-scroll')).getByTestId('voice-language');
    const before = chip.props.accessibilityLabel as string;
    await fireEvent.press(chip);
    await waitFor(() => expect(screen.getByTestId('voice-language').props.accessibilityLabel).not.toBe(before));
  });

  it('the discard question keeps the header and Back in the conversation at XL size', async () => {
    atScale(2.35);
    await showComposer();
    await fireEvent.changeText(screen.getByTestId('capture-input'), 'call Dana');
    // The discard question comes from «ابدأ من جديد» (M2b): Back keeps the draft.
    await fireEvent.press(screen.getByTestId('chat-more'));
    await fireEvent.press(screen.getByTestId('chat-menu-start-over'));
    await waitFor(() => expect(screen.getByTestId('capture-discard')).toBeTruthy());
    const conversation = within(screen.getByTestId('capture-scroll'));
    expect(conversation.getByTestId('chat-header')).toBeTruthy();
    expect(conversation.getByLabelText('Back')).toBeTruthy();
  });
});

describe('chat examples', () => {
  it('offers three examples that fill the draft without submitting', async () => {
    await showComposer();
    const examples = screen.getAllByTestId(/^chat-quick-example-/);
    expect(examples).toHaveLength(3);
    const firstExample = examples[0]!;
    await fireEvent.press(firstExample);
    expect(field()).toBe(firstExample.props.accessibilityLabel);
    expect(screen.getByTestId('capture-analyze')).toBeTruthy();
    expect(screen.queryByTestId('chat-schedule')).toBeNull();
    expect(screen.queryByText('Or share text, a link or a file from any app')).toBeNull();
  });
});
