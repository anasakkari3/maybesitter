/**
 * Importing from the clipboard, from the button a person presses
 * (UC-2.R2 #172, step 3).
 *
 * ── Why this renders `Root` ──────────────────────────────────────
 *
 * The same reason `captureFlowReachable.test.tsx` does. A clipboard import is
 * exactly the feature that gets built as a second, quicker path — read the
 * pasteboard, post it, show the result — and every unit test of the reducer
 * would stay green while it happened. So this starts at the tab bar, presses
 * the real button, and watches the real endpoints: if pasted text ever stopped
 * going through `textChanged` → analyze → review → confirm, these go red.
 *
 * The privacy claims are asserted here rather than described in a comment:
 * nothing is read until the button is pressed, nothing pasted is written to
 * storage, and nothing reaches the server before the user asks for it.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { getStringAsync } from 'expo-clipboard';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { Root } from '../../../Root';
import en from '../../../i18n/locales/en.json';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import { MAX_CAPTURE_LENGTH, captureReducer, initialCaptureState, type CaptureEvent } from '../captureMachine';
import * as captureEndpoints from '../../../api/endpoints/capture';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as trustEndpoints from '../../../api/endpoints/trust';

// The pasteboard is native. Mocked at the module boundary so each case can say
// what was copied — including "an image", which `getStringAsync` reports as an
// empty string on a device.
jest.mock('expo-clipboard', () => ({ getStringAsync: jest.fn(async () => '') }));
const clipboard = getStringAsync as unknown as jest.Mock<() => Promise<string | null>>;

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = {
  uid: 'capture-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

/** What someone copied out of a message and wants to capture. */
const COPIED = 'Hand in the report tomorrow at 3, and call Sami';

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

// A literal instant is a claim about the real calendar, and these fixtures flow
// into the edit sheet, whose guard refuses a time that has already passed. So a
// literal does not merely age — it rots into a failing suite the moment the wall
// clock walks past it, which is exactly what happened on 2026-09-14 (#352 fixed
// the same rot on the backend's tests). Derive from the clock the test runs on.
const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
const SOON = hoursFromNow(6);
const LATER = hoursFromNow(7);

function proposal(over: Record<string, unknown> = {}) {
  return {
    version: 'v1',
    proposalId: 'p-1',
    status: 'proposed',
    items: [
      { itemId: 'i-1', title: 'Hand in the report', resolvedTime: SOON, needsClarification: false },
    ],
    provenance: { requestedEngine: 'rules', executedEngine: 'rule-based', fallbackUsed: false },
    ...over,
  };
}

function confirmation(over: Record<string, unknown> = {}) {
  return {
    success: true,
    replayed: false,
    persisted: [{ itemId: 'i-1', commitmentId: 'c-1', title: 'Hand in the report', resolvedTime: SOON }],
    failed: [],
    ...over,
  };
}

beforeEach(async () => {
  onlineManager.setOnline(true);
  clipboard.mockReset();
  clipboard.mockResolvedValue('');
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  // English, because the assertions below quote en.json.
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
  jest.spyOn(trustEndpoints, 'getTrust')
    .mockResolvedValue({ success: true, participantId: 'capture-user', trust: { analyticsConsent: false } } as never);
});

afterEach(async () => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});

async function openComposer() {
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

/** Press Paste and wait for whichever sheet the pasteboard earns. */
async function pressPaste() {
  await fireEvent.press(screen.getByTestId('capture-paste'));
  await waitFor(() => expect(
    screen.queryByTestId('capture-clipboard') ?? screen.queryByTestId('capture-clipboard-empty'),
  ).not.toBeNull());
}

function fieldText(): string {
  return screen.getByTestId('capture-input').props.value as string;
}

describe('the clipboard is read only when asked', () => {
  it('is not touched by opening the composer', async () => {
    clipboard.mockResolvedValue(COPIED);
    await openComposer();
    // No read on mount, on focus, or on entering the flow. On iOS 14+ one here
    // would also raise the system's "pasted from …" banner.
    expect(clipboard).not.toHaveBeenCalled();
    expect(fieldText()).toBe('');
  });

  it('is read once, on the press, and shows what it found before using it', async () => {
    clipboard.mockResolvedValue(COPIED);
    await openComposer();
    await pressPaste();

    expect(clipboard).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('capture-clipboard')).not.toBeNull();
    // Shown, not used: the composer still holds nothing.
    expect(screen.queryByText(COPIED)).not.toBeNull();
    expect(screen.queryByTestId('capture-input')).toBeNull();
  });

  it('leaves the draft alone when the import is declined', async () => {
    clipboard.mockResolvedValue(COPIED);
    await openComposer();
    await fireEvent.changeText(screen.getByTestId('capture-input'), 'what I was writing');
    await pressPaste();
    // It says so, rather than silently overwriting somebody's draft.
    expect(screen.queryByTestId('capture-clipboard-replaces')).not.toBeNull();

    await fireEvent.press(screen.getByTestId('capture-clipboard-cancel'));
    await waitFor(() => expect(screen.queryByTestId('capture-input')).not.toBeNull());
    expect(fieldText()).toBe('what I was writing');
  });
});

describe('an empty clipboard is answered calmly', () => {
  it('says there is nothing to paste, and is not an error state', async () => {
    clipboard.mockResolvedValue('');
    await openComposer();
    await pressPaste();

    expect(screen.queryByTestId('capture-clipboard-empty')).not.toBeNull();
    expect(screen.queryByText(en.captureClipboardEmptyBody)).not.toBeNull();
    // None of the composer's failure screens, and no retry: nothing failed.
    expect(screen.queryByTestId('capture-error-networkError')).toBeNull();
    expect(screen.queryByTestId('capture-error-extractionFailed')).toBeNull();
    expect(screen.queryByTestId('capture-retry')).toBeNull();

    await fireEvent.press(screen.getByTestId('capture-clipboard-close'));
    await waitFor(() => expect(screen.queryByTestId('capture-input')).not.toBeNull());
    expect(fieldText()).toBe('');
  });

  it('treats a pasteboard the OS refused the same way', async () => {
    clipboard.mockRejectedValue(new Error('pasteboard unavailable'));
    await openComposer();
    await pressPaste();
    expect(screen.queryByTestId('capture-clipboard-empty')).not.toBeNull();
  });
});

describe('pasted text lands where typed text lands', () => {
  it('puts it in the composer, in the same state typing produces', async () => {
    clipboard.mockResolvedValue(COPIED);
    const propose = jest.spyOn(captureEndpoints, 'proposeCapture').mockResolvedValue(proposal() as never);
    await openComposer();
    await pressPaste();
    await fireEvent.press(screen.getByTestId('capture-clipboard-use'));
    await waitFor(() => expect(screen.queryByTestId('capture-input')).not.toBeNull());

    // The field holds it, and Analyze is live — which is `status: 'editing'`,
    // the state a keystroke produces and nothing else does.
    expect(fieldText()).toBe(COPIED);
    expect(screen.getByTestId('capture-analyze').props.accessibilityState.disabled).toBe(false);
    // And nothing has been sent. Importing is not analyzing.
    expect(propose).not.toHaveBeenCalled();
  });

  it('sends exactly what typing the same words sends', async () => {
    const propose = jest.spyOn(captureEndpoints, 'proposeCapture').mockResolvedValue(proposal() as never);

    clipboard.mockResolvedValue(COPIED);
    await openComposer();
    await pressPaste();
    await fireEvent.press(screen.getByTestId('capture-clipboard-use'));
    await waitFor(() => expect(screen.queryByTestId('capture-input')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('capture-analyze'));
    await waitFor(() => expect(screen.queryByTestId('review-item-i-1')).not.toBeNull());
    const pasted = propose.mock.calls[0]![0] as Record<string, unknown>;

    // The same words, typed, through the same screen.
    client.clear();
    propose.mockClear();
    await openComposer();
    await fireEvent.changeText(screen.getByTestId('capture-input'), COPIED);
    await fireEvent.press(screen.getByTestId('capture-analyze'));
    await waitFor(() => expect(screen.queryByTestId('review-item-i-1')).not.toBeNull());
    const typed = propose.mock.calls[0]![0] as Record<string, unknown>;

    expect(pasted.text).toBe(COPIED);
    expect(pasted.text).toBe(typed.text);
    expect(pasted.timezone).toBe(typed.timezone);
  });

  it('goes through the whole machine — review, confirm, undo', async () => {
    clipboard.mockResolvedValue(COPIED);
    jest.spyOn(captureEndpoints, 'proposeCapture').mockResolvedValue(proposal() as never);
    const confirm = jest.spyOn(captureEndpoints, 'confirmCapture').mockResolvedValue(confirmation() as never);
    await openComposer();
    await pressPaste();
    await fireEvent.press(screen.getByTestId('capture-clipboard-use'));
    await waitFor(() => expect(screen.queryByTestId('capture-input')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('capture-analyze'));

    // Review, with the line that says nothing has happened yet. A second
    // ingestion path is exactly the thing that would skip this screen.
    await waitFor(() => expect(screen.queryByTestId('review-note')).not.toBeNull());
    expect(screen.getByTestId('review-note').props.children).toBe(en.suggestionNote);
    expect(confirm).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId('review-confirm'));
    await waitFor(() => expect(screen.queryByTestId('saved-item-i-1')).not.toBeNull());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect((confirm.mock.calls[0]![0] as { proposalId: string }).proposalId).toBe('p-1');
    // The undo window a typed capture gets, on a pasted one.
    expect(screen.queryByTestId('saved-undo')).not.toBeNull();
  });

  it('truncates an over-long paste to what the field holds, and says so', async () => {
    clipboard.mockResolvedValue('x'.repeat(MAX_CAPTURE_LENGTH + 400));
    await openComposer();
    await pressPaste();
    await fireEvent.press(screen.getByTestId('capture-clipboard-use'));
    await waitFor(() => expect(screen.queryByTestId('capture-input')).not.toBeNull());

    expect(fieldText()).toHaveLength(MAX_CAPTURE_LENGTH);
    // The counter appears, so the limit is visible rather than silent.
    expect(screen.queryByTestId('capture-counter')).not.toBeNull();
  });
});

describe('the pasted draft is not written down', () => {
  it('never reaches storage', async () => {
    clipboard.mockResolvedValue(COPIED);
    const setItem = jest.spyOn(AsyncStorage, 'setItem');
    const multiSet = jest.spyOn(AsyncStorage, 'multiSet');
    await openComposer();
    await pressPaste();
    await fireEvent.press(screen.getByTestId('capture-clipboard-use'));
    await waitFor(() => expect(screen.queryByTestId('capture-input')).not.toBeNull());

    const written = JSON.stringify([...setItem.mock.calls, ...multiSet.mock.calls]);
    expect(written).not.toContain('Hand in the report');
    expect(written).not.toContain('Sami');
  });

  it('is gone when the flow is left', async () => {
    clipboard.mockResolvedValue(COPIED);
    await openComposer();
    await pressPaste();
    await fireEvent.press(screen.getByTestId('capture-clipboard-use'));
    await waitFor(() => expect(screen.queryByTestId('capture-input')).not.toBeNull());

    // Closing with text asks first, and throwing it away forgets it.
    await fireEvent.press(screen.getByText(en.cancel));
    await waitFor(() => expect(screen.queryByTestId('capture-discard')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('capture-discard-confirm'));
    await waitFor(() => expect(screen.queryByTestId('capture-input')).toBeNull());

    await fireEvent.press(screen.getByTestId('tab-capture'));
    await waitFor(() => expect(screen.queryByTestId('capture-input')).not.toBeNull());
    expect(fieldText()).toBe('');
  });
});

/**
 * There is one way text gets into this flow, and the clipboard uses it.
 *
 * The reducer is the whole surface: if `textChanged` is the only event that can
 * set `state.text`, then no feature — clipboard, share sheet, widget, voice —
 * can put text in front of the analyze/review/confirm sequence without going
 * through the same door. This asserts that against every event the machine has,
 * so a new one that carries text fails here on the day it is added.
 */
describe('there is only one way in', () => {
  const SMUGGLED = 'text that never asked permission';

  it('no event but textChanged can set the draft', () => {
    const base = captureReducer(initialCaptureState(), { type: 'textChanged', text: 'typed by hand' });
    const events: CaptureEvent[] = [
      { type: 'open' },
      { type: 'analyzeStarted' },
      { type: 'analyzeSucceeded', proposal: proposal() as never },
      { type: 'analyzeFailed', kind: 'network' },
      { type: 'toggleItem', itemId: 'i-1' },
      { type: 'editItem', itemId: 'i-1', edit: { title: 'x' } },
      { type: 'clearEdit', itemId: 'i-1' },
      { type: 'confirmStarted' },
      { type: 'confirmSucceeded', confirmation: confirmation() as never },
      { type: 'confirmFailed' },
      { type: 'undoWindowClosed' },
      { type: 'backToComposer' },
      { type: 'reset' },
    ];

    for (const event of events) {
      // `text` smuggled onto every other event, the way a second ingestion path
      // would have to carry it.
      const next = captureReducer(base, { ...event, text: SMUGGLED } as unknown as CaptureEvent);
      expect(next.text).not.toBe(SMUGGLED);
    }
    expect(captureReducer(base, { type: 'textChanged', text: SMUGGLED }).text).toBe(SMUGGLED);
  });

  it('the composer hands the clipboard to that one door and nothing else', () => {
    const source = readFileSync(join(__dirname, '..', '..', '..', 'screens', 'CaptureScreen.tsx'), 'utf8');
    // The import sheet's only output is wired to `setText`. If a future edit
    // gave it an `analyze()` or an endpoint of its own, this is what notices.
    expect(source).toMatch(/onUse=\{\(text\) => \{ flow\.setText\(text\); setClipboard\(null\); \}\}/);
    const sheet = readFileSync(join(__dirname, '..', 'ClipboardImportSheet.tsx'), 'utf8');
    for (const forbidden of ['flow.analyze', 'useCaptureFlow', 'api/endpoints', 'apiRequest', 'proposeCapture', 'confirmCapture']) {
      expect(sheet).not.toContain(forbidden);
    }
  });
});
