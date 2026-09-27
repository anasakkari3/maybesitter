/**
 * The bottom sheet clears the software keyboard (UAT round 2, N2, shot 156).
 *
 * Calendar → a busy block → «حضّرني» → tap the notes field: the keyboard came
 * up and the whole sheet — the question, the notes box, «اقترح خطوة» — stayed
 * behind it; only «إغلاق» showed. The sheet host is pinned to the bottom of
 * the window, and nothing lifted it: its ScrollView's
 * `automaticallyAdjustKeyboardInsets` only adds scrollable room *inside* a
 * viewport the keyboard already covered completely.
 *
 * The fix is CL2a's: the host is an `AvoidKeyboard`, padded by the keyboard's
 * overlap measured in window space (so the «أكّد إيميلك» banner above cannot
 * make it under-pad), and the prep sheet's primary action is pinned below its
 * scrolling body, so it stays above the keyboard while the notes scroll.
 */
import React from 'react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Keyboard, StyleSheet, type KeyboardEvent } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider, useApp } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../api/auth';
import type { AuthUser } from '../../auth/types';
import { CaptureProvider } from '../../features/capture/CaptureProvider';
import { LANGUAGE_STORAGE_KEY } from '../../i18n/language';
import * as windowFrame from '../../ui/windowFrame';
import * as consentEndpoints from '../../api/endpoints/consents';
import consentsFixture from '../../api/__fixtures__/consents.view.json';
import { SheetHost } from '../Sheets';

/** iPhone 17 Pro, the UAT device. */
const SCREEN_HEIGHT = 874;
const KEYBOARD_HEIGHT = 336;
const BANNER = 134;
const BOTTOM_INSET = 34;
const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 402, height: SCREEN_HEIGHT },
  insets: { top: 62, left: 0, right: 0, bottom: BOTTOM_INSET },
};
const USER: AuthUser = { uid: 'sheet-user', email: 'a@b.c', emailVerified: false, displayName: null, providerIds: ['password'] };
const START = new Date(Date.now() + 20 * 3_600_000).toISOString();

type Handler = (event: KeyboardEvent) => void;
let handlers: Record<string, Handler[]>;
let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

/** Opens a sheet the way the Calendar's «حضّرني» and Details' «تعديل» do. */
function Opener({ sheet }: { sheet: 'meetingPrep' | 'postpone' }) {
  const { actions } = useApp();
  const opened = React.useRef(false);
  React.useEffect(() => {
    // `actions` is a new object on every render; open once.
    if (opened.current) return;
    opened.current = true;
    if (sheet === 'meetingPrep') actions.openMeetingPrep({ startAt: START, endAt: null });
    else actions.openPostpone();
  }, [actions, sheet]);
  return null;
}

function HostOver() {
  const { s } = useApp();
  return <SheetHost key={s.sheet ?? 'none'} />;
}

beforeEach(async () => {
  onlineManager.setOnline(true);
  handlers = {};
  jest.spyOn(Keyboard, 'addListener').mockImplementation(((name: string, handler: Handler) => {
    (handlers[name] ??= []).push(handler);
    return { remove: () => { handlers[name] = (handlers[name] ?? []).filter((h) => h !== handler); } };
  }) as never);
  jest.spyOn(consentEndpoints, 'getConsents').mockResolvedValue(consentsFixture as never);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
});

afterEach(async () => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});

async function open(sheet: 'meetingPrep' | 'postpone') {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <QueryClientProvider client={client}>
        <AuthProvider repository={repository} isDevBundle={false}>
          <AppProvider>
            <CaptureProvider>
              <HostOver />
              <Opener sheet={sheet} />
            </CaptureProvider>
          </AppProvider>
        </AuthProvider>
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('sheet-host')).not.toBeNull());
}

/** Lays the host out `top` points down the window, filling the rest of it. */
async function layOut(top: number) {
  const height = SCREEN_HEIGHT - top;
  jest.spyOn(windowFrame, 'measureWindowFrame').mockResolvedValue({ y: top, height });
  await fireEvent(screen.getByTestId('sheet-host'), 'layout', {
    persist: () => {},
    nativeEvent: { layout: { x: 0, y: 0, width: 402, height } },
  });
}

async function keyboard(event: 'keyboardWillShow' | 'keyboardWillHide') {
  const payload = {
    duration: 250,
    easing: 'keyboard',
    isEventFromThisApp: true,
    startCoordinates: { screenX: 0, screenY: SCREEN_HEIGHT, width: 402, height: KEYBOARD_HEIGHT },
    endCoordinates: { screenX: 0, screenY: SCREEN_HEIGHT - KEYBOARD_HEIGHT, width: 402, height: KEYBOARD_HEIGHT },
  } as KeyboardEvent;
  await React.act(async () => {
    for (const handler of handlers[event] ?? []) handler(payload);
  });
}

const styleOf = (testID: string) =>
  StyleSheet.flatten(screen.getByTestId(testID).props.style) as { paddingBottom?: number; flexShrink?: number };

describe('the meeting-prep sheet with the software keyboard up (N2)', () => {
  it('lifts the whole sheet by the keyboard, with the verify-email banner above', async () => {
    await open('meetingPrep');
    await waitFor(() => expect(screen.getByTestId('meeting-prep-notes')).toBeTruthy());
    await layOut(BANNER);
    await keyboard('keyboardWillShow');
    // Not 336 − 134: the overlap is measured in the space the keyboard reports in.
    await waitFor(() => expect(styleOf('sheet-host').paddingBottom).toBe(KEYBOARD_HEIGHT));
    const host = within(screen.getByTestId('sheet-host'));
    expect(host.queryByTestId('meeting-prep-notes')).not.toBeNull();
    expect(host.queryByTestId('meeting-prep-submit')).not.toBeNull();
    // The lifted panel may be shorter than its content: it shrinks, and its
    // body scrolls, instead of running off the top of the window.
    expect(styleOf('sheet-panel').flexShrink).toBe(1);
  });

  it('keeps «اقترح خطوة» pinned below the scrolling notes, so it stays above the keyboard', async () => {
    await open('meetingPrep');
    await waitFor(() => expect(screen.getByTestId('meeting-prep-notes')).toBeTruthy());
    const body = within(screen.getByTestId('meeting-prep-scroll'));
    expect(body.queryByTestId('meeting-prep-notes')).not.toBeNull();
    expect(body.queryByTestId('meeting-prep-submit')).toBeNull();
    expect(within(screen.getByTestId('meeting-prep-footer')).queryByTestId('meeting-prep-submit')).not.toBeNull();
  });

  it('does not pad twice: no scroller in the sheet also insets itself for the keyboard', async () => {
    // A native keyboard inset is computed once, from the frame *before* the
    // lift, and then stays: a blank keyboard-high tail under the notes.
    await open('meetingPrep');
    await waitFor(() => expect(screen.getByTestId('meeting-prep-notes')).toBeTruthy());
    expect(screen.getByTestId('meeting-prep-scroll').props.automaticallyAdjustKeyboardInsets).not.toBe(true);
    // And for the host's other sheets, whose scroller only renders with a commitment.
    for (const file of ['../Sheets.tsx', '../../features/meetings/MeetingPrepSheet.tsx']) {
      expect(`${file}: ${/<ScrollView\b[^>]*\bautomaticallyAdjustKeyboardInsets\b/.test(readFileSync(join(__dirname, file), 'utf8'))}`).toBe(`${file}: false`);
    }
  });

  it('with the keyboard up the footer drops the home-indicator clearance; it comes back when the keyboard goes', async () => {
    await open('meetingPrep');
    await waitFor(() => expect(screen.getByTestId('meeting-prep-notes')).toBeTruthy());
    expect(styleOf('meeting-prep-footer').paddingBottom).toBe(BOTTOM_INSET + 24);
    await layOut(0);
    await keyboard('keyboardWillShow');
    await waitFor(() => expect(styleOf('sheet-host').paddingBottom).toBe(KEYBOARD_HEIGHT));
    // The keyboard covers the home indicator; its clearance would only push
    // the notes up by 34pt more on a phone that has none to spare.
    expect(styleOf('meeting-prep-footer').paddingBottom).toBe(12);
    await keyboard('keyboardWillHide');
    await waitFor(() => expect(styleOf('sheet-host').paddingBottom).toBe(0));
    expect(styleOf('meeting-prep-footer').paddingBottom).toBe(BOTTOM_INSET + 24);
  });
});

describe('every sheet in the host shares the lift', () => {
  it('the «مش هلّق» sheet is lifted by the same container', async () => {
    await open('postpone');
    await layOut(BANNER);
    await keyboard('keyboardWillShow');
    await waitFor(() => expect(styleOf('sheet-host').paddingBottom).toBe(KEYBOARD_HEIGHT));
  });
});
