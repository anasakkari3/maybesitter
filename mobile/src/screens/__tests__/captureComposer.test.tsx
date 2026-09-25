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
  async cancel(): Promise<void> {}
  partial(text: string) { this.callbacks.onPartial?.(text); }
  final(text: string) { this.callbacks.onFinal?.(text); }
}

const mockSpeech = new FakeSpeech();

jest.mock('../../features/capture/voice/speechService', () => ({
  createSpeechCaptureService: () => mockSpeech,
  SpeechEventBridge: () => null,
}));

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function flat(style: unknown): Record<string, unknown> {
  return StyleSheet.flatten(style) as Record<string, unknown>;
}

let client: QueryClient;

beforeEach(async () => {
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

describe('the keyboard cannot hide Analyze or the text', () => {
  it('Analyze and the mic are outside the ScrollView, inside the keyboard-avoiding view', async () => {
    await showComposer();
    const scroll = within(screen.getByTestId('capture-scroll'));
    expect(scroll.queryByTestId('capture-analyze')).toBeNull();
    expect(scroll.queryByTestId('voice-button')).toBeNull();

    const footer = within(screen.getByTestId('capture-footer'));
    expect(footer.queryByTestId('capture-analyze')).not.toBeNull();
    expect(footer.queryByTestId('voice-button')).not.toBeNull();
    expect(within(screen.getByTestId('capture-kav')).queryByTestId('capture-footer')).not.toBeNull();
  });

  it('the input is capped in height and scrolls inside itself', async () => {
    await showComposer();
    const input = screen.getByTestId('capture-input');
    const style = flat(input.props.style);
    expect(typeof style.maxHeight).toBe('number');
    expect(style.maxHeight as number).toBeGreaterThanOrEqual(style.minHeight as number);
    expect(input.props.scrollEnabled).toBe(true);
  });
});

describe('less copy above the fold', () => {
  it('shows three examples, not five, and no share hint', async () => {
    await showComposer();
    const examples = screen.queryAllByTestId(/^capture-example-/);
    expect(examples).toHaveLength(3);
    expect(screen.queryByText('Or share text, a link or a file from any app')).toBeNull();
  });
});
