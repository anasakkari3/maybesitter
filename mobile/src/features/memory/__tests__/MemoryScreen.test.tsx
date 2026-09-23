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
import type { MemoryAdaptive, MemoryItem, MemorySuggestion } from '../../../api/schemas/profile';
import { MemoryScreen, UNDO_WINDOW_MS } from '../MemoryScreen';
import en from '../../../i18n/locales/en.json';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';

import { NotFoundError, NetworkError } from '../../../api/errors';

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
      pattern: null,
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
  provenance: { origin: 'behaviour_rule', originRef: 'R1_focus_window:09:00-12:00', confirmedByUserAt: RECORDED },
  evidence: {
    origin: 'behaviour_rule',
    observedAt: RECORDED,
    recordedAt: RECORDED,
    confirmedAt: RECORDED,
    edited: false,
    observationCount: 8,
    pattern: { ruleId: 'R1_focus_window', window: { start: '09:00', end: '12:00' } },
  },
});

const SUGGESTION: MemorySuggestion = {
  ruleId: 'R1_focus_window',
  fingerprint: 'R1_focus_window:14:00-17:00',
  window: { start: '14:00', end: '17:00' },
  confidence: 0.7,
  evidence: { matchingCount: 7, totalCount: 10, lookbackDays: 28 },
};

/** R2's claim (UC-3.14, #532): minutes on the wire, words on the phone. */
const DEFER_SUGGESTION: MemorySuggestion = {
  ruleId: 'R2_defer_default',
  fingerprint: 'R2_defer_default:60m',
  deferMinutes: 60,
  confidence: 0.67,
  evidence: { matchingCount: 4, totalCount: 6, lookbackDays: 28 },
};

const DEFER_NOTICED = item({
  id: 'mem_defer',
  kind: 'preference',
  content: 'When you push something later, it’s usually by 1 hour.',
  source: 'deterministic_rule',
  sourceLabel: 'noticed_from_confirmed',
  confidence: 0.67,
  staleAfter: NINETY_DAYS,
  provenance: { origin: 'behaviour_rule', originRef: 'R2_defer_default:60m', confirmedByUserAt: RECORDED },
  evidence: {
    origin: 'behaviour_rule',
    observedAt: RECORDED,
    recordedAt: RECORDED,
    confirmedAt: RECORDED,
    edited: false,
    observationCount: 4,
    pattern: { ruleId: 'R2_defer_default', deferMinutes: 60 },
  },
});

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

function listing(items: MemoryItem[], suggestions: MemorySuggestion[] = [], adaptive: MemoryAdaptive | null = null) {
  jest.spyOn(profileEndpoints, 'listMemory').mockResolvedValue({ items, suggestions, adaptive } as never);
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
  jest.spyOn(profileEndpoints, 'keepMemorySuggestion').mockResolvedValue({ success: true, decision: 'keep', memory: NOTICED } as never);
  jest.spyOn(profileEndpoints, 'dismissMemorySuggestion').mockResolvedValue({ success: true, decision: 'dismiss' } as never);
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

  it('does not claim there are no memories when the request failed', async () => {
    jest.spyOn(profileEndpoints, 'listMemory').mockRejectedValue(new NetworkError('offline'));
    await show(<MemoryScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('query-error')).not.toBeNull());
    expect(screen.queryByTestId('memory-screen-empty')).toBeNull();
    expect(screen.getByRole('button', { name: en.errorsRetry })).toBeTruthy();
  });

  it('is empty rather than broken when the feature is off', async () => {
    jest.spyOn(profileEndpoints, 'listMemory').mockRejectedValue(new NotFoundError('not found'));
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

describe('suggestions (#202)', () => {
  it('offers one as not saved, with what it was read from, and never the share as a number', async () => {
    listing([item()], [SUGGESTION]);
    await show(<MemoryScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('memory-suggestions')).not.toBeNull());

    expect(screen.getByTestId('memory-suggestions-lede').props.children).toBe(en.memorySuggestionsLede);
    const sentence = screen.getByTestId('memory-suggestion-R1_focus_window:14:00-17:00').props.children as string;
    expect(sentence).toContain('14:00');
    expect(sentence).toContain('17:00');
    const evidence = screen.getByTestId('memory-suggestion-evidence-R1_focus_window:14:00-17:00').props.children as string;
    expect(evidence).toContain('28');
    expect(evidence).toContain('10');
    expect(evidence).toContain('7');
    // Anywhere on the screen, not only as a whole text node: a share tucked
    // onto the end of a sentence is still a score printed about a person.
    expect(screen.queryByText(/0\.7|70\s*%/)).toBeNull();
    expect(`${sentence} ${evidence}`).not.toMatch(/0\.7|70\s*%/);
  });

  it('shows no suggestions card when there is nothing to suggest', async () => {
    listing([item()]);
    await show(<MemoryScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('memory-group-told')).not.toBeNull());
    expect(screen.queryByTestId('memory-suggestions')).toBeNull();
  });

  it('shows a suggestion even when nothing is remembered yet', async () => {
    listing([], [SUGGESTION]);
    await show(<MemoryScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('memory-suggestions')).not.toBeNull());
  });

  it('Keep sends the suggestion back with the language the sentence is stored in', async () => {
    listing([], [SUGGESTION]);
    await show(<MemoryScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('memory-suggestion-keep-R1_focus_window:14:00-17:00')).not.toBeNull());

    await act(async () => { fireEvent.press(screen.getByTestId('memory-suggestion-keep-R1_focus_window:14:00-17:00')); });

    await waitFor(() => expect(profileEndpoints.keepMemorySuggestion).toHaveBeenCalled());
    const [sent, language] = (profileEndpoints.keepMemorySuggestion as jest.Mock).mock.calls[0] as [MemorySuggestion, string];
    expect(sent.fingerprint).toBe(SUGGESTION.fingerprint);
    expect(['en', 'ar', 'he']).toContain(language);
    expect(profileEndpoints.dismissMemorySuggestion).not.toHaveBeenCalled();
  });

  it('Keep stores the sentence in the language the app is in, not English', async () => {
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
    try {
      listing([], [SUGGESTION]);
      await show(<MemoryScreen onBack={() => {}} />);
      await waitFor(() => expect(screen.queryByTestId('memory-suggestion-keep-R1_focus_window:14:00-17:00')).not.toBeNull());
      await act(async () => { fireEvent.press(screen.getByTestId('memory-suggestion-keep-R1_focus_window:14:00-17:00')); });

      await waitFor(() => expect(profileEndpoints.keepMemorySuggestion).toHaveBeenCalled());
      const [, language] = (profileEndpoints.keepMemorySuggestion as jest.Mock).mock.calls[0] as [MemorySuggestion, string];
      expect(language).toBe('ar');
    } finally {
      await AsyncStorage.removeItem(LANGUAGE_STORAGE_KEY);
    }
  });

  it('"Not right" dismisses, and keeps nothing', async () => {
    listing([], [SUGGESTION]);
    await show(<MemoryScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('memory-suggestion-dismiss-R1_focus_window:14:00-17:00')).not.toBeNull());

    await act(async () => { fireEvent.press(screen.getByTestId('memory-suggestion-dismiss-R1_focus_window:14:00-17:00')); });

    await waitFor(() => expect(profileEndpoints.dismissMemorySuggestion).toHaveBeenCalled());
    expect(profileEndpoints.keepMemorySuggestion).not.toHaveBeenCalled();
  });

  it('a kept pattern says, under Why?, that the plan uses it and that deleting it stops that', async () => {
    listing([NOTICED]);
    await show(<MemoryScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('memory-why-mem_noticed')).not.toBeNull());
    await act(async () => { fireEvent.press(screen.getByTestId('memory-why-mem_noticed')); });

    expect(screen.getByTestId('memory-evidence-mem_noticed-plan').props.children).toContain(en.memoryWhyPlanUse);
    const pattern = screen.getByTestId('memory-evidence-mem_noticed-pattern').props.children as string;
    expect(pattern).toContain('09:00');
    expect(screen.getByTestId('memory-evidence-mem_noticed-origin').props.children).toContain(en.memoryOriginRule);
  });

  it('words R2 as a duration, sends its own ruleId back, and still shows no share', async () => {
    listing([], [DEFER_SUGGESTION]);
    await show(<MemoryScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('memory-suggestion-R2_defer_default:60m')).not.toBeNull());

    // "1 hour", not "60": the server sends minutes and the phone owns the words.
    const sentence = screen.getByTestId('memory-suggestion-R2_defer_default:60m').props.children as string;
    expect(sentence).toContain(en.memoryDurationHour);
    expect(sentence).not.toContain('60');
    expect(sentence).not.toMatch(/\{|\}/);
    const evidence = screen.getByTestId('memory-suggestion-evidence-R2_defer_default:60m').props.children as string;
    expect(evidence).toContain('6');
    expect(evidence).toContain('4');
    expect(`${sentence} ${evidence}`).not.toMatch(/0\.67|67\s*%/);

    await act(async () => { fireEvent.press(screen.getByTestId('memory-suggestion-keep-R2_defer_default:60m')); });
    await waitFor(() => expect(profileEndpoints.keepMemorySuggestion).toHaveBeenCalled());
    const [sent] = (profileEndpoints.keepMemorySuggestion as jest.Mock).mock.calls[0] as [MemorySuggestion, string];
    // The route is keyed on the ruleId, so R2 keeping under R1's id would be a 409.
    expect(sent.ruleId).toBe('R2_defer_default');
    expect(sent.fingerprint).toBe('R2_defer_default:60m');
  });

  it('a kept R2 pattern says what it was read from, and that the plan does not use it', async () => {
    listing([DEFER_NOTICED]);
    await show(<MemoryScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('memory-why-mem_defer')).not.toBeNull());
    await act(async () => { fireEvent.press(screen.getByTestId('memory-why-mem_defer')); });

    const pattern = screen.getByTestId('memory-evidence-mem_defer-pattern').props.children as string;
    expect(pattern).toContain(en.memoryDurationHour);
    expect(pattern).not.toMatch(/\{|\}/);
    // R1's window shapes the next plan and says so; nothing reads a kept
    // defer duration, and the line has to say that rather than borrow R1's.
    const plan = screen.getByTestId('memory-evidence-mem_defer-plan').props.children as string;
    expect(plan).toContain(en.memoryWhyDeferNoPlanUse);
    expect(plan).not.toContain(en.memoryWhyPlanUse);
  });

  it('a fact the user typed says nothing about the plan', async () => {
    await show(<MemoryScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('memory-why-mem_told')).not.toBeNull());
    await act(async () => { fireEvent.press(screen.getByTestId('memory-why-mem_told')); });
    expect(screen.queryByTestId('memory-evidence-mem_told-plan')).toBeNull();
  });
});

describe('how reminders adapt (#202)', () => {
  const AVOIDANT: MemoryAdaptive = {
    classification: 'avoidant',
    effect: { maxPressureLevel: 'low', suggestionStyle: 'supportive' },
  };

  it('shows the group the server read and what it may change, with nothing to press', async () => {
    listing([item()], [], AVOIDANT);
    await show(<MemoryScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('memory-adaptive')).not.toBeNull());

    expect(screen.getByTestId('memory-adaptive-classification').props.children).toBe(en.memoryAdaptiveClassAvoidant);
    expect(screen.getByTestId('memory-adaptive-effect').props.children).toBe(en.memoryAdaptiveEffect);
    // Read-only: the group is set from behaviour, so there is no control to offer.
    expect(screen.queryByTestId('memory-adaptive-edit')).toBeNull();
  });

  it('says there is nothing to read a group from yet, instead of showing a default label', async () => {
    listing([item()], [], { classification: null, effect: null });
    await show(<MemoryScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('memory-adaptive')).not.toBeNull());

    expect(screen.getByTestId('memory-adaptive-unset').props.children).toBe(en.memoryAdaptiveUnset);
    expect(screen.queryByTestId('memory-adaptive-classification')).toBeNull();
    // The guarantee is about what a group may change; it is true with no group too.
    expect(screen.getByTestId('memory-adaptive-effect').props.children).toBe(en.memoryAdaptiveEffect);
  });

  it('renders no section for a server that does not send the field', async () => {
    listing([item()]);
    await show(<MemoryScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('memory-group-told')).not.toBeNull());
    expect(screen.queryByTestId('memory-adaptive')).toBeNull();
  });
});
