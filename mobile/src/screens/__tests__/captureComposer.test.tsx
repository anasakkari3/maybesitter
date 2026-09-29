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
import { ScrollView, StyleSheet } from 'react-native';
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

/**
 * UAT round 6, #5 (eef25054, shots 1034–1040): with the software keyboard up
 * the field was 313–531pt, the ScrollView's viewport ended at 462 and the
 * footer covered 462–538 — the line being typed and the caret were under
 * «فهمها», and `capture-scroll` never scrolled. Jest has no keyboard, so the
 * geometry arrives as the layout events the device sends: the ScrollView
 * shrinks to ~207pt when AvoidKeyboard lifts the footer, and the field starts
 * 58pt into the scroll content (16pt padding + the label and its gap).
 */
describe('the line being typed stays above the footer and keyboard (#5)', () => {
  const layout = (height: number, y = 0) => ({ nativeEvent: { layout: { x: 0, y, width: 358, height } } });

  async function keyboardUp(viewport: number) {
    await fireEvent(screen.getByTestId('capture-scroll'), 'layout', layout(viewport));
    await fireEvent(screen.getByTestId('capture-editor'), 'layout', layout(400, 16));
    await fireEvent(screen.getByTestId('capture-field'), 'layout', layout(140, 42));
  }

  it('the field shrinks to end above the footer instead of keeping its 220pt cap', async () => {
    await showComposer();
    await keyboardUp(207);
    const style = flat(screen.getByTestId('capture-input').props.style);
    // 58pt down + the field + an 8pt gap ≤ the 207pt viewport.
    expect(58 + (style.maxHeight as number) + 8).toBeLessThanOrEqual(207);
    expect(style.minHeight as number).toBeLessThanOrEqual(style.maxHeight as number);
    expect(screen.getByTestId('capture-input').props.scrollEnabled).toBe(true);
  });

  it('with the keyboard down the field keeps its resting cap', async () => {
    await showComposer();
    await keyboardUp(600);
    expect(flat(screen.getByTestId('capture-input').props.style).maxHeight).toBe(220);
  });

  it('a field that cannot fit under the label scrolls the ScrollView so its bottom shows', async () => {
    const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => {});
    await showComposer();
    await fireEvent(screen.getByTestId('capture-scroll'), 'layout', layout(150));
    await fireEvent(screen.getByTestId('capture-editor'), 'layout', layout(400, 16));
    const maxHeight = flat(screen.getByTestId('capture-input').props.style).maxHeight as number;
    await fireEvent(screen.getByTestId('capture-field'), 'layout', layout(maxHeight, 42));
    // The field's bottom (58 + maxHeight) plus the gap, at the viewport's bottom edge.
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 58 + maxHeight + 8 - 150, animated: false });
  });

  it('scrolled down to the privacy line, typing a line brings the field back', async () => {
    const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => {});
    await showComposer();
    await keyboardUp(207);
    await fireEvent.scroll(screen.getByTestId('capture-scroll'), { nativeEvent: { contentOffset: { x: 0, y: 300 } } });
    scrollTo.mockClear();
    await fireEvent(screen.getByTestId('capture-field'), 'layout', layout(141, 42));
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 58, animated: false });
  });

  it('at the largest text size the field keeps two whole lines and the ScrollView scrolls to show it', async () => {
    // English at 20pt × 1.4 = 28pt a line; at fontScale 3.1 (AX5) ≈ 87pt.
    useWindowDimensions.mockReturnValue({ width: 390, height: 844, scale: 3, fontScale: 3.1 });
    const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => {});
    await showComposer();
    await fireEvent(screen.getByTestId('capture-scroll'), 'layout', layout(260));
    await fireEvent(screen.getByTestId('capture-editor'), 'layout', layout(600, 16));
    await fireEvent(screen.getByTestId('capture-field'), 'layout', layout(140, 150));
    const maxHeight = flat(screen.getByTestId('capture-input').props.style).maxHeight as number;
    expect(maxHeight).toBe(52 + 2 * Math.round(28 * 3.1));
    await fireEvent(screen.getByTestId('capture-field'), 'layout', layout(maxHeight, 150));
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 166 + maxHeight + 8 - 260, animated: false });
  });

  it('with the field gone (the discard question), a layout change does not scroll to where it was', async () => {
    const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => {});
    await showComposer();
    await keyboardUp(207);
    await fireEvent.changeText(screen.getByTestId('capture-input'), 'call Dana');
    await fireEvent.press(screen.getByLabelText('Cancel'));
    await waitFor(() => expect(screen.queryByTestId('capture-discard')).not.toBeNull());
    scrollTo.mockClear();
    await fireEvent(screen.getByTestId('capture-scroll'), 'layout', layout(100));
    expect(scrollTo).not.toHaveBeenCalled();
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
