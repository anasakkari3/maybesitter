/**
 * The memory screen (UC-3.16, #202).
 *
 * Four claims are load-bearing here, and each has a test that fails when it
 * stops being true:
 *
 *  - a fact is filed under *who asserted it*, so a user can see at a glance
 *    what they said and what the product decided;
 *  - "Why?" answers from the record, and says plainly when nothing was
 *    observed, rather than leaving a transparency panel blank;
 *  - confidence is words; the number never reaches the screen;
 *  - the undo window holds the delete, and **leaving the screen commits it** —
 *    a delete that silently did not happen is the worse of the two failures.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import type { MemoryItem } from '../../../api/schemas/profile';
import { MemoryScreen, UNDO_WINDOW_MS } from '../MemoryScreen';
import en from '../../../i18n/locales/en.json';

import * as profileEndpoints from '../../../api/endpoints/profile';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const USER: AuthUser = {
  uid: 'memory-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

const RECORDED = '2026-09-13T09:00:00.000Z';
/** Ten years out: the store's way of writing "until you change it". */
const FOREVER = '2036-09-13T09:00:00.000Z';
/** Ninety days out: an inference with a real expiry. */
const NINETY_DAYS = '2026-12-12T09:00:00.000Z';

function item(over: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: 'mem_told',
    kind: 'fact',
    content: 'I cook on Fridays',
    language: 'en',
    source: 'user_stated',
    sourceLabel: 'you_told_us',
    confidence: 1,
    createdAt: RECORDED,
    observedAt: RECORDED,
    staleAfter: FOREVER,
    provenance: { origin: 'manual' },
    evidence: {
      origin: 'manual',
      observedAt: RECORDED,
      recordedAt: RECORDED,
      confirmedAt: null,
      edited: false,
      observationCount: 0,
    },
    ...over,
  } as MemoryItem;
}

const NOTICED = item({
  id: 'mem_noticed',
  kind: 'preference',
  content: 'You often finish things between 09:00 and 12:00',
  source: 'deterministic_rule',
  sourceLabel: 'noticed_from_confirmed',
  confidence: 0.7,
  staleAfter: NINETY_DAYS,
  provenance: null,
  evidence: {
    origin: null,
    observedAt: RECORDED,
    recordedAt: RECORDED,
    confirmedAt: null,
    edited: false,
    observationCount: 8,
  },
});

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

function listing(items: MemoryItem[]) {
  jest.spyOn(profileEndpoints, 'listMemory').mockResolvedValue({ items } as never);
}

beforeEach(() => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  listing([item()]);
  jest.spyOn(profileEndpoints, 'patchMemory').mockResolvedValue({ success: true, memory: item() } as never);
  jest.spyOn(profileEndpoints, 'deleteMemory').mockResolvedValue({ success: true, deleted: 1 } as never);
  jest.spyOn(profileEndpoints, 'deleteAllMemory').mockResolvedValue({ success: true, deleted: 1 } as never);
});

afterEach(() => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

async function show(node: React.ReactNode) {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}>{node}</QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

describe('what the screen shows', () => {
  it('files each fact under who asserted it, and prints no empty headings', async () => {
    listing([item(), NOTICED]);
    await show(<MemoryScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('memory-group-told')).not.toBeNull());

    expect(screen.queryByTestId('memory-group-noticed')).not.toBeNull();
    // Nothing model-inferred exists; the heading for it does not appear as an
    // empty shelf implying something is missing.
    expect(screen.queryByTestId('memory-group-suggested')).toBeNull();
  });

  it('names the source of every row from the server’s own classification', async () => {
    listing([item({ sourceLabel: 'you_answered_onboarding' })]);
    await show(<MemoryScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('memory-screen-source-mem_told')).not.toBeNull());
    expect(screen.getByTestId('memory-screen-source-mem_told').props.children)
      .toBe(en.memorySourceOnboarding);
  });

  it('says how sure it is in words, and never shows the number', async () => {
    listing([item(), NOTICED]);
    await show(<MemoryScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('memory-confidence-mem_told')).not.toBeNull());

    expect(screen.getByTestId('memory-confidence-mem_told').props.children).toBe(en.memorySureCertain);
    expect(screen.getByTestId('memory-confidence-mem_noticed').props.children).toBe(en.memorySureFairly);
    // 0.7 is a threshold comparison, not a measurement of the person.
    expect(screen.queryByText('0.7')).toBeNull();
    expect(screen.queryByText('70%')).toBeNull();
  });

  it('is empty rather than broken when the feature is off', async () => {
    jest.spyOn(profileEndpoints, 'listMemory').mockRejectedValue(new Error('not found'));
    await show(<MemoryScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('memory-screen-empty')).not.toBeNull());
    // And the way back is still there: a blank page with no exit is worse.
    expect(screen.queryByText(en.settingsBack)).not.toBeNull();
  });
});

describe('Why?', () => {
  it('is closed until asked, then answers from the record', async () => {
    await show(<MemoryScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('memory-why-mem_told')).not.toBeNull());
    expect(screen.queryByTestId('memory-evidence-mem_told')).toBeNull();

    await act(async () => { fireEvent.press(screen.getByTestId('memory-why-mem_told')); });

    expect(screen.queryByTestId('memory-evidence-mem_told-origin')).not.toBeNull();
    expect(screen.queryByTestId('memory-evidence-mem_told-recorded')).not.toBeNull();
  });

  it('says plainly that nothing was observed, rather than leaving the panel bare', async () => {
    await show(<MemoryScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('memory-why-mem_told')).not.toBeNull());
    await act(async () => { fireEvent.press(screen.getByTestId('memory-why-mem_told')); });

    const line = screen.getByTestId('memory-evidence-mem_told-observations').props.children as string;
    expect(line).toContain(en.memoryWhyNoObservations);
  });

  it('words a ten-year TTL as "until you change it" and a real expiry as a date', async () => {
    listing([item(), NOTICED]);
    await show(<MemoryScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('memory-why-mem_told')).not.toBeNull());

    await act(async () => { fireEvent.press(screen.getByTestId('memory-why-mem_told')); });
    expect(screen.getByTestId('memory-evidence-mem_told-stale').props.children)
      .toContain(en.memoryKeptUntilChanged);

    await act(async () => { fireEvent.press(screen.getByTestId('memory-why-mem_noticed')); });
    const guess = screen.getByTestId('memory-evidence-mem_noticed-stale').props.children as string;
    expect(guess).toContain('Dec');
    expect(guess).not.toContain(en.memoryKeptUntilChanged);
  });

  it('admits when a row replaced something the user changed', async () => {
    listing([item({ evidence: { ...item().evidence, edited: true } })]);
    await show(<MemoryScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('memory-why-mem_told')).not.toBeNull());
    await act(async () => { fireEvent.press(screen.getByTestId('memory-why-mem_told')); });

    expect(screen.getByTestId('memory-evidence-mem_told-edited').props.children)
      .toContain(en.memoryWhyEdited);
  });
});

describe('editing', () => {
  it('sends the correction as a patch, which the server turns into a new record', async () => {
    await show(<MemoryScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('memory-screen-edit-mem_told')).not.toBeNull());

    await act(async () => { fireEvent.press(screen.getByTestId('memory-screen-edit-mem_told')); });
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('memory-screen-edit-input-mem_told'), 'I cook on Saturdays');
    });
    await act(async () => { fireEvent.press(screen.getByTestId('memory-screen-save-mem_told')); });

    await waitFor(() => expect(profileEndpoints.patchMemory).toHaveBeenCalledWith('mem_told', 'I cook on Saturdays'));
  });
});

describe('delete, and the five seconds after it', () => {
  it('hides the row at once and sends nothing yet', async () => {
    jest.useFakeTimers();
    await show(<MemoryScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('memory-screen-delete-mem_told')).not.toBeNull());

    await act(async () => { fireEvent.press(screen.getByTestId('memory-screen-delete-mem_told')); });

    expect(screen.queryByTestId('memory-screen-item-mem_told')).toBeNull();
    expect(screen.queryByTestId('memory-undo-bar')).not.toBeNull();
    expect(profileEndpoints.deleteMemory).not.toHaveBeenCalled();
  });

  it('brings the row back and never calls the server when undone in time', async () => {
    jest.useFakeTimers();
    await show(<MemoryScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('memory-screen-delete-mem_told')).not.toBeNull());

    await act(async () => { fireEvent.press(screen.getByTestId('memory-screen-delete-mem_told')); });
    await act(async () => { fireEvent.press(screen.getByTestId('memory-undo')); });

    expect(screen.queryByTestId('memory-screen-item-mem_told')).not.toBeNull();
    await act(async () => { jest.advanceTimersByTime(UNDO_WINDOW_MS * 2); });
    expect(profileEndpoints.deleteMemory).not.toHaveBeenCalled();
  });

  it('sends the delete once the window closes', async () => {
    jest.useFakeTimers();
    await show(<MemoryScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('memory-screen-delete-mem_told')).not.toBeNull());

    await act(async () => { fireEvent.press(screen.getByTestId('memory-screen-delete-mem_told')); });
    await act(async () => { jest.advanceTimersByTime(UNDO_WINDOW_MS); });

    expect(profileEndpoints.deleteMemory).toHaveBeenCalledWith('mem_told');
  });

  it('commits the delete when the user leaves before the window closes', async () => {
    // The user pressed Delete and watched the row go. A deletion that quietly
    // did not happen because they navigated away is the worse failure.
    jest.useFakeTimers();
    const view = await show(<MemoryScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('memory-screen-delete-mem_told')).not.toBeNull());

    await act(async () => { fireEvent.press(screen.getByTestId('memory-screen-delete-mem_told')); });
    await act(async () => { view.unmount(); });

    expect(profileEndpoints.deleteMemory).toHaveBeenCalledWith('mem_told');
  });
});

describe('delete everything', () => {
  it('names the behaviour log on the confirm, not in a footnote', async () => {
    await show(<MemoryScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('memory-screen-delete-all')).not.toBeNull());

    await act(async () => { fireEvent.press(screen.getByTestId('memory-screen-delete-all')); });

    // The derived profile is the half the user cannot see, so the moment they
    // agree to erase it is the one moment they can be told it is going.
    expect(screen.getByTestId('memory-delete-all-also').props.children).toBe(en.memoryDeleteAllAlso);
    expect(profileEndpoints.deleteAllMemory).not.toHaveBeenCalled();

    await act(async () => { fireEvent.press(screen.getByTestId('memory-screen-delete-all-confirm')); });
    await waitFor(() => expect(profileEndpoints.deleteAllMemory).toHaveBeenCalled());
  });
});
