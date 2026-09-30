/**
 * The composer's footer clears the keyboard when something sits above the
 * screen (UAT 2026-09-26, complaint #6, shot 31).
 *
 * The «أكّد إيميلك» banner is 134pt tall and sits above the capture screen for
 * every unverified email account. React Native's KeyboardAvoidingView compares
 * its own frame — measured relative to its parent — with the keyboard's screen
 * coordinates, so it under-padded by exactly the banner's height and «فهمها»
 * sat under the keyboard. The padding has to be the overlap in window space.
 */
import React from 'react';
import { Keyboard, Platform, StyleSheet, type KeyboardEvent } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { CaptureProvider } from '../../features/capture/CaptureProvider';
import { LANGUAGE_STORAGE_KEY } from '../../i18n/language';
import * as windowFrame from '../../ui/windowFrame';
import { CaptureScreen } from '../CaptureScreen';

jest.mock('../../features/capture/voice/speechService', () => ({
  createSpeechCaptureService: () => ({
    locale: 'en-US', status: 'idle', start: async () => {}, stop: async () => {}, cancel: async () => {},
  }),
  SpeechEventBridge: () => null,
}));

/** iPhone 17 Pro, the UAT device. */
const SCREEN_HEIGHT = 874;
const KEYBOARD_HEIGHT = 336;
const BANNER = 134;

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 402, height: SCREEN_HEIGHT },
  insets: { top: 62, left: 0, right: 0, bottom: 34 },
};

type Handler = (event: KeyboardEvent) => void;
let handlers: Record<string, Handler[]>;
let client: QueryClient;

beforeEach(async () => {
  handlers = {};
  jest.spyOn(Keyboard, 'addListener').mockImplementation(((name: string, handler: Handler) => {
    (handlers[name] ??= []).push(handler);
    return { remove: () => { handlers[name] = (handlers[name] ?? []).filter((h) => h !== handler); } };
  }) as never);
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

/** Lays the composer out `top` points down the window, filling the rest of it. */
async function layOut(top: number) {
  const height = SCREEN_HEIGHT - top;
  jest.spyOn(windowFrame, 'measureWindowFrame').mockResolvedValue({ y: top, height });
  // What the view's own onLayout reports: relative to its parent, so y is 0
  // whatever sits above the parent.
  await fireEvent(screen.getByTestId('capture-kav'), 'layout', {
    persist: () => {},
    nativeEvent: { layout: { x: 0, y: 0, width: 402, height } },
  });
}

async function showKeyboard() {
  const event = {
    duration: 250,
    easing: 'keyboard',
    isEventFromThisApp: true,
    startCoordinates: { screenX: 0, screenY: SCREEN_HEIGHT, width: 402, height: KEYBOARD_HEIGHT },
    endCoordinates: { screenX: 0, screenY: SCREEN_HEIGHT - KEYBOARD_HEIGHT, width: 402, height: KEYBOARD_HEIGHT },
  } as KeyboardEvent;
  await React.act(async () => {
    for (const handler of handlers.keyboardWillShow ?? []) handler(event);
  });
}

const bottomPadding = () =>
  (StyleSheet.flatten(screen.getByTestId('capture-kav').props.style) as { paddingBottom?: number }).paddingBottom ?? 0;

describe('the capture footer clears the keyboard', () => {
  it('with the verify-email banner above the screen, it lifts by the whole keyboard', async () => {
    await showComposer();
    await layOut(BANNER);
    await showKeyboard();
    // The screen's bottom edge is the window's; the keyboard covers its last
    // 336pt, and the footer has to clear all of them — not 336 − 134.
    await waitFor(() => expect(bottomPadding()).toBe(KEYBOARD_HEIGHT));
    expect(within(screen.getByTestId('capture-kav')).queryByTestId('chat-composer')).not.toBeNull();
  });

  it('with nothing above the screen, it lifts by the keyboard too', async () => {
    await showComposer();
    await layOut(0);
    await showKeyboard();
    await waitFor(() => expect(bottomPadding()).toBe(KEYBOARD_HEIGHT));
  });

  it('drops the lift when the keyboard goes away', async () => {
    await showComposer();
    await layOut(BANNER);
    await showKeyboard();
    await waitFor(() => expect(bottomPadding()).toBe(KEYBOARD_HEIGHT));
    await React.act(async () => {
      for (const handler of handlers.keyboardWillHide ?? []) handler({} as KeyboardEvent);
    });
    await waitFor(() => expect(bottomPadding()).toBe(0));
  });
});

/*
 * UAT 2026-09-30, u13/u13b (Android, docked Gboard): the page header moved
 * but the input and the send button stayed behind the keyboard. Under SDK
 * 57's edge-to-edge the window does not resize for the IME, and the lift
 * listened only for iOS's `Will` events. Android posts `keyboardDidShow`,
 * whose `screenY` is the bottom of the window's visible frame — the
 * keyboard's top edge — in the same window space `measureInWindow` reports.
 */
describe('the capture footer clears the keyboard on Android', () => {
  const originalOs = Platform.OS;
  beforeEach(() => { Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true }); });
  afterEach(() => { Object.defineProperty(Platform, 'OS', { value: originalOs, configurable: true }); });

  /** The emulator of the UAT: 411×923dp; Gboard reaches 377dp up, nav bar included. */
  const ANDROID_HEIGHT = 923;
  const IME = 377;

  async function androidKeyboard(name: 'keyboardDidShow' | 'keyboardDidHide', top: number) {
    await React.act(async () => {
      for (const handler of handlers[name] ?? []) {
        handler({ endCoordinates: { screenX: 0, screenY: top, width: 411, height: name === 'keyboardDidShow' ? IME - 24 : 0 } } as KeyboardEvent);
      }
    });
  }

  it('lifts the composer by the docked keyboard, and drops the lift when it goes', async () => {
    await showComposer();
    jest.spyOn(windowFrame, 'measureWindowFrame').mockResolvedValue({ y: 0, height: ANDROID_HEIGHT });
    await androidKeyboard('keyboardDidShow', ANDROID_HEIGHT - IME);
    await waitFor(() => expect(bottomPadding()).toBe(IME));
    expect(within(screen.getByTestId('capture-kav')).queryByTestId('chat-composer')).not.toBeNull();
    await androidKeyboard('keyboardDidHide', ANDROID_HEIGHT);
    await waitFor(() => expect(bottomPadding()).toBe(0));
  });

  it('follows a height change Android reports as a second DidShow', async () => {
    await showComposer();
    jest.spyOn(windowFrame, 'measureWindowFrame').mockResolvedValue({ y: 0, height: ANDROID_HEIGHT });
    await androidKeyboard('keyboardDidShow', ANDROID_HEIGHT - IME);
    await waitFor(() => expect(bottomPadding()).toBe(IME));
    await androidKeyboard('keyboardDidShow', ANDROID_HEIGHT - IME - 60);
    await waitFor(() => expect(bottomPadding()).toBe(IME + 60));
  });

  it('does not pad a window that already resized above the keyboard', async () => {
    await showComposer();
    jest.spyOn(windowFrame, 'measureWindowFrame').mockResolvedValue({ y: 0, height: ANDROID_HEIGHT - IME });
    await androidKeyboard('keyboardDidShow', ANDROID_HEIGHT - IME);
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(bottomPadding()).toBe(0);
  });
});
