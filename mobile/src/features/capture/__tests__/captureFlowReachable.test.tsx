/**
 * The capture flow, from an entry point a user can actually reach
 * (UC-2.R2, #172).
 *
 * ── Why this renders `Root` and not the screens ──────────────────
 *
 * The machine, the gateway and the provider were all built and unit-tested
 * before this, and none of it was reachable: nothing outside
 * `src/features/capture/` imported any of them, while the composer ran a mock
 * rule engine against the design's sample sentences. Every one of those unit
 * tests passed the whole time.
 *
 * So this test starts where the user does — the capture button in the tab bar —
 * and drives the real screens against a mocked `fetch`-level endpoint. If the
 * wiring comes undone again, tapping the button stops producing a proposal and
 * this goes red, which no test of the reducer can do.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { Root } from '../../../Root';
import en from '../../../i18n/locales/en.json';
import ar from '../../../i18n/locales/ar.json';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';

import { InputTooLargeError, NetworkError, QuotaExceededError, ValidationError } from '../../../api/errors';
import * as captureEndpoints from '../../../api/endpoints/capture';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = {
  uid: 'capture-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

function proposal(over: Record<string, unknown> = {}) {
  return {
    version: 'v1',
    proposalId: 'p-1',
    status: 'proposed',
    items: [
      {
        itemId: 'i-1',
        title: 'Hand in the report',
        resolvedTime: '2026-09-14T15:00:00.000Z',
        needsClarification: false,
        priority: 'high',
        priorityEstimated: true,
      },
      {
        itemId: 'i-2',
        title: 'Call Sami',
        resolvedTime: null,
        needsClarification: false,
      },
    ],
    provenance: { requestedEngine: 'rules', executedEngine: 'rule-based', fallbackUsed: false },
    ...over,
  };
}

function confirmation(over: Record<string, unknown> = {}) {
  return {
    success: true,
    replayed: false,
    persisted: [{ itemId: 'i-1', commitmentId: 'c-1', title: 'Hand in the report', resolvedTime: '2026-09-14T15:00:00.000Z' }],
    failed: [],
    ...over,
  };
}

beforeEach(() => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  // Today and the next step render behind the flow; they are not what this
  // test is about, and an unmocked call would be a network error in the tree.
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
});

afterEach(() => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

async function openApp() {
  const view = await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}><Root /></QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('tab-capture')).not.toBeNull());
  return view;
}

/** Tap the capture button in the tab bar — the way into the flow. */
async function enterCapture() {
  // By testID, not label: `tabCapture` and `captureTitle` are both «احكيها».
  await fireEvent.press(screen.getByTestId('tab-capture'));
  await waitFor(() => expect(screen.queryByTestId('capture-input')).not.toBeNull());
}

async function typeAndAnalyze(text = 'Hand in the report tomorrow at 6, and call Sami') {
  await fireEvent.changeText(screen.getByTestId('capture-input'), text);
  await fireEvent.press(screen.getByTestId('capture-analyze'));
  await waitFor(() => expect(screen.queryByTestId('review-item-i-1')).not.toBeNull());
}

describe('the flow is reachable from the tab bar', () => {
  it('the capture button opens the composer', async () => {
    await openApp();
    await enterCapture();
    expect(screen.queryByTestId('capture-input')).not.toBeNull();
  });

  it('typing and analyzing calls the real endpoint and shows the server’s proposal', async () => {
    const propose = jest.spyOn(captureEndpoints, 'proposeCapture').mockResolvedValue(proposal() as never);
    await openApp();
    await enterCapture();
    await typeAndAnalyze();

    expect(propose).toHaveBeenCalledTimes(1);
    // Both items the *server* returned, not a canned pair from a rule engine.
    expect(screen.queryByText('Hand in the report')).not.toBeNull();
    expect(screen.queryByText('Call Sami')).not.toBeNull();
  });

  it('sends the text the user typed, with a timezone and a reference time', async () => {
    const propose = jest.spyOn(captureEndpoints, 'proposeCapture').mockResolvedValue(proposal() as never);
    await openApp();
    await enterCapture();
    await typeAndAnalyze('Call the clinic at 9');

    // The endpoint fills `referenceTime` itself, so what the flow must supply
    // is the text and the zone the server resolves "at 9" against.
    const sent = propose.mock.calls[0]![0] as { text: string; timezone?: string };
    expect(sent.text).toBe('Call the clinic at 9');
    expect(typeof sent.timezone).toBe('string');
    expect(sent.timezone).not.toBe('');
  });

  it('analyze is refused while the field is empty', async () => {
    await openApp();
    await enterCapture();
    expect(screen.getByTestId('capture-analyze').props.accessibilityState.disabled).toBe(true);
  });
});

describe('review sends only what was selected', () => {
  it('confirms both by default', async () => {
    jest.spyOn(captureEndpoints, 'proposeCapture').mockResolvedValue(proposal() as never);
    const confirm = jest.spyOn(captureEndpoints, 'confirmCapture').mockResolvedValue(confirmation() as never);
    await openApp();
    await enterCapture();
    await typeAndAnalyze();

    await fireEvent.press(screen.getByTestId('review-confirm'));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    const sent = confirm.mock.calls[0]![0] as { proposalId: string; itemIds: string[] };
    expect(sent.proposalId).toBe('p-1');
    expect([...sent.itemIds].sort()).toEqual(['i-1', 'i-2']);
  });

  it('drops a deselected item from the confirm, and leaves it on screen', async () => {
    jest.spyOn(captureEndpoints, 'proposeCapture').mockResolvedValue(proposal() as never);
    const confirm = jest.spyOn(captureEndpoints, 'confirmCapture').mockResolvedValue(confirmation() as never);
    await openApp();
    await enterCapture();
    await typeAndAnalyze();

    await fireEvent.press(screen.getByTestId('review-item-i-2'));
    // Still visible after deselecting: the count has to be checkable before
    // pressing a button that writes. Asserted before the confirm, because the
    // confirm moves to the success screen.
    expect(screen.queryByText('Call Sami')).not.toBeNull();

    await fireEvent.press(screen.getByTestId('review-confirm'));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect((confirm.mock.calls[0]![0] as { itemIds: string[] }).itemIds).toEqual(['i-1']);
  });

  it('cannot confirm nothing', async () => {
    jest.spyOn(captureEndpoints, 'proposeCapture').mockResolvedValue(proposal() as never);
    const confirm = jest.spyOn(captureEndpoints, 'confirmCapture');
    await openApp();
    await enterCapture();
    await typeAndAnalyze();

    await fireEvent.press(screen.getByTestId('review-item-i-1'));
    await fireEvent.press(screen.getByTestId('review-item-i-2'));
    await waitFor(() => expect(screen.queryByTestId('review-none-selected')).not.toBeNull());
    expect(screen.getByTestId('review-confirm').props.accessibilityState.disabled).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('says nothing has been saved yet, on the screen where it matters most', async () => {
    jest.spyOn(captureEndpoints, 'proposeCapture').mockResolvedValue(proposal() as never);
    await openApp();
    await enterCapture();
    await typeAndAnalyze();
    expect(screen.getByTestId('review-note').props.children).toBe(en.suggestionNote);
  });

  it('marks an importance the extractor guessed', async () => {
    jest.spyOn(captureEndpoints, 'proposeCapture').mockResolvedValue(proposal() as never);
    await openApp();
    await enterCapture();
    await typeAndAnalyze();
    expect(screen.queryByTestId('review-estimated-i-1')).not.toBeNull();
    expect(screen.queryByTestId('review-estimated-i-2')).toBeNull();
  });
});

describe('success shows what the server saved', () => {
  it('lists only persisted items', async () => {
    jest.spyOn(captureEndpoints, 'proposeCapture').mockResolvedValue(proposal() as never);
    jest.spyOn(captureEndpoints, 'confirmCapture').mockResolvedValue(confirmation() as never);
    await openApp();
    await enterCapture();
    await typeAndAnalyze();
    await fireEvent.press(screen.getByTestId('review-confirm'));
    await waitFor(() => expect(screen.queryByTestId('saved-item-i-1')).not.toBeNull());
    // `i-2` was selected and the server did not report it saved, so it is not
    // shown as saved.
    expect(screen.queryByTestId('saved-item-i-2')).toBeNull();
  });

  it('shows refused items apart from saved ones', async () => {
    jest.spyOn(captureEndpoints, 'proposeCapture').mockResolvedValue(proposal() as never);
    jest.spyOn(captureEndpoints, 'confirmCapture').mockResolvedValue(
      confirmation({ failed: [{ itemId: 'i-2', reason: 'invalid_time' }] }) as never,
    );
    await openApp();
    await enterCapture();
    await typeAndAnalyze();
    await fireEvent.press(screen.getByTestId('review-confirm'));
    await waitFor(() => expect(screen.queryByTestId('saved-failed')).not.toBeNull());
    expect(screen.queryByTestId('saved-failed-i-2')).not.toBeNull();
  });

  it('undo deletes what was saved, and says so only when nothing is left', async () => {
    jest.spyOn(captureEndpoints, 'proposeCapture').mockResolvedValue(proposal() as never);
    jest.spyOn(captureEndpoints, 'confirmCapture').mockResolvedValue(confirmation() as never);
    const remove = jest.spyOn(commitmentEndpoints, 'deleteCommitment')
      .mockResolvedValue({ deleted: false, softDeleted: true, id: 'c-1' } as never);
    await openApp();
    await enterCapture();
    await typeAndAnalyze();
    await fireEvent.press(screen.getByTestId('review-confirm'));
    await waitFor(() => expect(screen.queryByTestId('saved-undo')).not.toBeNull());

    await fireEvent.press(screen.getByTestId('saved-undo'));
    await waitFor(() => expect(screen.queryByTestId('saved-undo-outcome')).not.toBeNull());
    expect(remove).toHaveBeenCalledWith('c-1');
    expect(screen.queryByText(en.undoneTitle)).not.toBeNull();
  });

  it('never claims a full undo when a delete failed', async () => {
    jest.spyOn(captureEndpoints, 'proposeCapture').mockResolvedValue(proposal() as never);
    jest.spyOn(captureEndpoints, 'confirmCapture').mockResolvedValue(confirmation() as never);
    jest.spyOn(commitmentEndpoints, 'deleteCommitment').mockRejectedValue(new Error('offline'));
    await openApp();
    await enterCapture();
    await typeAndAnalyze();
    await fireEvent.press(screen.getByTestId('review-confirm'));
    await waitFor(() => expect(screen.queryByTestId('saved-undo')).not.toBeNull());

    await fireEvent.press(screen.getByTestId('saved-undo'));
    await waitFor(() => expect(screen.queryByTestId('saved-undo-partial')).not.toBeNull());
    // A user told it was undone stops checking.
    expect(screen.queryByText(en.undoneTitle)).toBeNull();
    expect(screen.queryByText(/Hand in the report/)).not.toBeNull();
  });
});

describe('nothing to save (#166)', () => {
  it('says only that, with the server’s reason and no echo of the message', async () => {
    jest.spyOn(captureEndpoints, 'proposeCapture').mockResolvedValue(
      proposal({ status: 'no_commitment', noCommitmentReason: 'greeting_or_chat', items: [] }) as never,
    );
    await openApp();
    await enterCapture();
    await fireEvent.changeText(screen.getByTestId('capture-input'), 'hey, how are you');
    await fireEvent.press(screen.getByTestId('capture-analyze'));
    await waitFor(() => expect(screen.queryByTestId('capture-nothing')).not.toBeNull());

    expect(screen.getByTestId('capture-nothing-reason').props.children)
      .toBe(en.noCommitmentGreetingOrChat);
    // The message is not quoted back. Repeating what somebody wrote under a
    // heading is a response to the person rather than to their request.
    expect(screen.queryByText(/hey, how are you/)).toBeNull();
  });

  it('falls back to the neutral line for a reason this build does not know', async () => {
    jest.spyOn(captureEndpoints, 'proposeCapture').mockResolvedValue(
      proposal({ status: 'no_commitment', noCommitmentReason: undefined, items: [] }) as never,
    );
    await openApp();
    await enterCapture();
    await fireEvent.changeText(screen.getByTestId('capture-input'), 'mm');
    await fireEvent.press(screen.getByTestId('capture-analyze'));
    await waitFor(() => expect(screen.queryByTestId('capture-nothing')).not.toBeNull());
    expect(screen.getByTestId('capture-nothing-reason').props.children)
      .toBe(en.noCommitmentInformational);
  });
});

describe('failures are told apart', () => {
  it('offers a retry for a network failure', async () => {
    jest.spyOn(captureEndpoints, 'proposeCapture').mockRejectedValue(new NetworkError('offline'));
    await openApp();
    await enterCapture();
    await fireEvent.changeText(screen.getByTestId('capture-input'), 'something');
    await fireEvent.press(screen.getByTestId('capture-analyze'));
    await waitFor(() => expect(screen.queryByTestId('capture-error-networkError')).not.toBeNull());
    expect(screen.queryByTestId('capture-retry')).not.toBeNull();
  });

  it('offers no retry for input the server refused', async () => {
    jest.spyOn(captureEndpoints, 'proposeCapture').mockRejectedValue(new ValidationError('too long'));
    await openApp();
    await enterCapture();
    await fireEvent.changeText(screen.getByTestId('capture-input'), 'something');
    await fireEvent.press(screen.getByTestId('capture-analyze'));
    await waitFor(() => expect(screen.queryByTestId('capture-error-validationError')).not.toBeNull());
    // It will be refused again. A Retry here invites pressing until they give up.
    expect(screen.queryByTestId('capture-retry')).toBeNull();
  });
});

/**
 * Hitting the AI cap (UC-4.5, #181).
 *
 * The localized lines existed; nothing could reach them. The composer saw a 429
 * as neither a `ValidationError` nor retryable, called it `extraction`, and
 * drew its own "something went wrong" with a Retry button underneath — against
 * a quota, which is the one thing a retry cannot help and the loop the quota
 * exists to stop.
 *
 * This drives the real screens from the tab bar, in both languages the app can
 * actually be in. Hebrew is not one of them: `src/i18n/strings.ts` types `Lang`
 * as 'ar' | 'en' and `resolveLanguage` falls back to English for anything else,
 * so a "Hebrew" render here would be an English render with a Hebrew label on
 * it. The Hebrew copy and its mapping are asserted directly in
 * `src/api/__tests__/quotaError.test.ts`.
 */
describe('a spent AI quota says so', () => {
  const TYPED = 'Call the clinic tomorrow at 9 and book Lina’s dentist';

  async function refuse(error: unknown, lang: 'en' | 'ar' = 'en') {
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
    jest.spyOn(captureEndpoints, 'proposeCapture').mockRejectedValue(error as Error);
    await openApp();
    await enterCapture();
    await fireEvent.changeText(screen.getByTestId('capture-input'), TYPED);
    await fireEvent.press(screen.getByTestId('capture-analyze'));
    await waitFor(() => expect(screen.queryByTestId('capture-error-refused')).not.toBeNull());
  }

  it('shows the daily-limit line, not “something went wrong”', async () => {
    await refuse(new QuotaExceededError('user_daily', 3600));
    expect(screen.queryByText(en.aiQuotaUserDaily)).not.toBeNull();
    expect(screen.queryByText(en.errorsGeneric)).toBeNull();
  });

  it('shows the same line in Arabic', async () => {
    await refuse(new QuotaExceededError('user_daily', 3600), 'ar');
    expect(screen.queryByText(ar.aiQuotaUserDaily)).not.toBeNull();
    expect(screen.queryByText(ar.errorsGeneric)).toBeNull();
  });

  it('tells a minute’s rate limit apart from a day’s', async () => {
    await refuse(new QuotaExceededError('user_minute', 30));
    expect(screen.queryByText(en.aiQuotaTryLater)).not.toBeNull();
  });

  it('does not blame the user when the service itself is out', async () => {
    await refuse(new QuotaExceededError('global_daily', 7200));
    expect(screen.queryByText(en.aiServiceUnavailable)).not.toBeNull();
  });

  it('says the text is too long when it is', async () => {
    await refuse(new InputTooLargeError(20_000));
    expect(screen.queryByText(en.aiInputTooLong)).not.toBeNull();
  });

  it('offers no Retry, because pressing it is what the quota refuses', async () => {
    await refuse(new QuotaExceededError('user_daily', 3600));
    expect(screen.queryByTestId('capture-retry')).toBeNull();
  });

  it('still has what the person typed, in the field, after Back', async () => {
    // The worst available response to a full counter is losing somebody's
    // words. Asserted on the input's own value, not on the reducer.
    await refuse(new QuotaExceededError('user_daily', 3600));
    await fireEvent.press(screen.getByTestId('capture-error-back'));
    await waitFor(() => expect(screen.queryByTestId('capture-input')).not.toBeNull());
    expect(screen.getByTestId('capture-input').props.value).toBe(TYPED);
  });
});

describe('closing forgets the draft', () => {
  it('asks before throwing away text', async () => {
    await openApp();
    await enterCapture();
    await fireEvent.changeText(screen.getByTestId('capture-input'), 'a half-written thought');
    await fireEvent.press(screen.getByLabelText(en.cancel));
    await waitFor(() => expect(screen.queryByTestId('capture-discard')).not.toBeNull());
  });

  it('keeps the text when the discard is declined', async () => {
    await openApp();
    await enterCapture();
    await fireEvent.changeText(screen.getByTestId('capture-input'), 'a half-written thought');
    await fireEvent.press(screen.getByLabelText(en.cancel));
    await waitFor(() => expect(screen.queryByTestId('capture-discard')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('capture-discard-keep'));
    await waitFor(() => expect(screen.queryByTestId('capture-input')).not.toBeNull());
    expect(screen.getByTestId('capture-input').props.value).toBe('a half-written thought');
  });

  it('leaves immediately when there is nothing to lose', async () => {
    await openApp();
    await enterCapture();
    await fireEvent.press(screen.getByLabelText(en.cancel));
    await waitFor(() => expect(screen.queryByTestId('capture-input')).toBeNull());
  });

  it('re-entering after a discard starts empty', async () => {
    await openApp();
    await enterCapture();
    await fireEvent.changeText(screen.getByTestId('capture-input'), 'forget me');
    await fireEvent.press(screen.getByLabelText(en.cancel));
    await waitFor(() => expect(screen.queryByTestId('capture-discard')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('capture-discard-confirm'));
    await waitFor(() => expect(screen.queryByTestId('capture-input')).toBeNull());

    await enterCapture();
    expect(screen.getByTestId('capture-input').props.value).toBe('');
  });
});

describe('the one question (#165)', () => {
  const asking = () => proposal({
    status: 'needs_clarification',
    items: [{
      itemId: 'i-1',
      title: 'Call Dana',
      resolvedTime: null,
      needsClarification: true,
      clarification: {
        questionId: 'q-1',
        field: 'time',
        questionKey: 'ask_time',
        params: {},
        options: [
          { optionId: 'o-morning', labelKey: 'morning', labelParams: {}, value: { localTime: '09:00' } },
          { optionId: 'o-evening', labelKey: 'evening', labelParams: {}, value: { localTime: '19:00' } },
        ],
        allowFreeText: true,
      },
    }],
  });

  const answered = () => proposal({
    items: [{ itemId: 'i-1', title: 'Call Dana', resolvedTime: '2026-09-14T16:00:00.000Z', needsClarification: false, clarification: null }],
  });

  async function reachTheQuestion() {
    jest.spyOn(captureEndpoints, 'proposeCapture').mockResolvedValue(asking() as never);
    await openApp();
    await enterCapture();
    await fireEvent.changeText(screen.getByTestId('capture-input'), 'remind me to call Dana');
    await fireEvent.press(screen.getByTestId('capture-analyze'));
    await waitFor(() => expect(screen.queryByTestId('clarify-sheet')).not.toBeNull());
  }

  it('asks it, in words from the locale files', async () => {
    await reachTheQuestion();
    expect(screen.getByTestId('clarify-question').props.children).toBe(en.clarifyAskTime);
    // Not the key, and not anything the server phrased.
    expect(screen.queryByText('ask_time')).toBeNull();
    expect(screen.queryByText(/morning/i)).not.toBeNull();
  });

  it('sends the option the user picked, and shows the updated proposal', async () => {
    const clarify = jest.spyOn(captureEndpoints, 'clarifyCapture').mockResolvedValue(answered() as never);
    await reachTheQuestion();
    await fireEvent.press(screen.getByTestId('clarify-option-o-evening'));
    await waitFor(() => expect(clarify).toHaveBeenCalled());

    const sent = clarify.mock.calls[0]![0] as { itemId: string; questionId: string; optionId?: string };
    expect(sent).toMatchObject({ itemId: 'i-1', questionId: 'q-1', optionId: 'o-evening' });
    // The question is gone and the item is confirmable.
    await waitFor(() => expect(screen.queryByTestId('clarify-sheet')).toBeNull());
    expect(screen.getByTestId('review-confirm').props.accessibilityState.disabled).toBe(false);
  });

  it('sends free text as free text, not as a title', async () => {
    const clarify = jest.spyOn(captureEndpoints, 'clarifyCapture').mockResolvedValue(answered() as never);
    await reachTheQuestion();
    await fireEvent.changeText(screen.getByTestId('clarify-free-text'), 'بالمسا');
    await fireEvent.press(screen.getByTestId('clarify-send'));
    await waitFor(() => expect(clarify).toHaveBeenCalled());
    expect(clarify.mock.calls[0]![0]).toMatchObject({ freeText: 'بالمسا' });
  });

  it('keeps the question up when the answer fails', async () => {
    jest.spyOn(captureEndpoints, 'clarifyCapture').mockRejectedValue(new NetworkError('offline'));
    await reachTheQuestion();
    await fireEvent.press(screen.getByTestId('clarify-option-o-morning'));
    // Clearing it would look like the answer landed.
    await waitFor(() => expect(screen.queryByTestId('clarify-sheet')).not.toBeNull());
  });

  it('skipping leaves the item flagged rather than walling the user in', async () => {
    await reachTheQuestion();
    await fireEvent.press(screen.getByTestId('clarify-skip'));
    await waitFor(() => expect(screen.queryByTestId('clarify-sheet')).toBeNull());
    expect(screen.queryByTestId('review-needs-question-i-1')).not.toBeNull();
  });

  it('does not ask a question this build has no words for', async () => {
    // A server ahead of the app. The item keeps its flag and #164's edit sheet
    // is the way through; an internal token must never reach the screen.
    const unknown = asking();
    (unknown.items[0] as unknown as { clarification: { questionKey: string } })
      .clarification.questionKey = 'ask_something_new';
    jest.spyOn(captureEndpoints, 'proposeCapture').mockResolvedValue(unknown as never);
    await openApp();
    await enterCapture();
    await fireEvent.changeText(screen.getByTestId('capture-input'), 'remind me to call Dana');
    await fireEvent.press(screen.getByTestId('capture-analyze'));
    await waitFor(() => expect(screen.queryByTestId('review-item-i-1')).not.toBeNull());

    expect(screen.queryByTestId('clarify-sheet')).toBeNull();
    expect(screen.queryByText('ask_something_new')).toBeNull();
    expect(screen.queryByTestId('review-needs-question-i-1')).not.toBeNull();
  });
});

describe('editing before anything is saved (#164)', () => {
  async function reachReview() {
    jest.spyOn(captureEndpoints, 'proposeCapture').mockResolvedValue(proposal() as never);
    await openApp();
    await enterCapture();
    await typeAndAnalyze();
  }

  it('shows the edited title on the card, not the original', async () => {
    // Showing the original under a card the user has changed is how somebody
    // confirms something they did not mean.
    await reachReview();
    await fireEvent.press(screen.getByTestId('review-edit-i-1'));
    await waitFor(() => expect(screen.queryByTestId('edit-item-sheet')).not.toBeNull());
    await fireEvent.changeText(screen.getByTestId('edit-item-title'), 'Hand in the short report');
    await fireEvent.press(screen.getByTestId('edit-item-save'));
    await waitFor(() => expect(screen.queryByTestId('edit-item-sheet')).toBeNull());
    expect(screen.queryByText('Hand in the short report')).not.toBeNull();
    expect(screen.queryByText('Hand in the report')).toBeNull();
  });

  it('sends the edit with the confirm, in the same request', async () => {
    const confirm = jest.spyOn(captureEndpoints, 'confirmCapture').mockResolvedValue(confirmation() as never);
    const patch = jest.spyOn(commitmentEndpoints, 'patchCommitment');
    await reachReview();
    await fireEvent.press(screen.getByTestId('review-edit-i-1'));
    await waitFor(() => expect(screen.queryByTestId('edit-item-sheet')).not.toBeNull());
    await fireEvent.changeText(screen.getByTestId('edit-item-title'), 'Hand in the short report');
    await fireEvent.press(screen.getByTestId('edit-item-save'));
    await fireEvent.press(screen.getByTestId('review-confirm'));
    await waitFor(() => expect(confirm).toHaveBeenCalled());

    const sent = confirm.mock.calls[0]![0] as { edits?: { itemId: string; title?: string }[] };
    expect(sent.edits).toEqual([{ itemId: 'i-1', title: 'Hand in the short report' }]);
    // Never a PATCH afterwards: that leaves the user holding a title they
    // already changed for as long as the second request takes.
    expect(patch).not.toHaveBeenCalled();
  });

  it('sends a priority the user set, and stops calling it a guess', async () => {
    const confirm = jest.spyOn(captureEndpoints, 'confirmCapture').mockResolvedValue(confirmation() as never);
    await reachReview();
    expect(screen.queryByTestId('review-estimated-i-1')).not.toBeNull();

    await fireEvent.press(screen.getByTestId('review-edit-i-1'));
    await waitFor(() => expect(screen.queryByTestId('edit-item-priority-low')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('edit-item-priority-low'));
    await fireEvent.press(screen.getByTestId('edit-item-save'));
    await waitFor(() => expect(screen.queryByTestId('edit-item-sheet')).toBeNull());

    // It is theirs now, so the "we guessed" mark goes.
    expect(screen.queryByTestId('review-estimated-i-1')).toBeNull();

    await fireEvent.press(screen.getByTestId('review-confirm'));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect((confirm.mock.calls[0]![0] as { edits?: { priority?: string }[] }).edits)
      .toEqual([{ itemId: 'i-1', priority: 'low' }]);
  });

  it('"No time" is an answer, and is sent as one', async () => {
    const confirm = jest.spyOn(captureEndpoints, 'confirmCapture').mockResolvedValue(confirmation() as never);
    await reachReview();
    await fireEvent.press(screen.getByTestId('review-edit-i-1'));
    await waitFor(() => expect(screen.queryByTestId('edit-item-no-time')).not.toBeNull());
    await fireEvent(screen.getByTestId('edit-item-no-time'), 'valueChange', true);
    await fireEvent.press(screen.getByTestId('edit-item-save'));
    await fireEvent.press(screen.getByTestId('review-confirm'));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    // `null`, not an absent field: an absent field means "not touched".
    expect((confirm.mock.calls[0]![0] as { edits?: { resolvedTime?: string | null }[] }).edits)
      .toEqual([{ itemId: 'i-1', resolvedTime: null }]);
  });

  it('refuses an empty title while the sheet is open', async () => {
    await reachReview();
    await fireEvent.press(screen.getByTestId('review-edit-i-1'));
    await waitFor(() => expect(screen.queryByTestId('edit-item-title')).not.toBeNull());
    await fireEvent.changeText(screen.getByTestId('edit-item-title'), '   ');
    expect(screen.getByTestId('edit-item-save').props.accessibilityState.disabled).toBe(true);
    expect(screen.queryByTestId('edit-item-problem')).not.toBeNull();
  });

  it('sends no edits at all when nothing was changed', async () => {
    const confirm = jest.spyOn(captureEndpoints, 'confirmCapture').mockResolvedValue(confirmation() as never);
    await reachReview();
    await fireEvent.press(screen.getByTestId('review-edit-i-1'));
    await waitFor(() => expect(screen.queryByTestId('edit-item-sheet')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('edit-item-save'));
    await fireEvent.press(screen.getByTestId('review-confirm'));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    // An entry with nothing but an id asks the server to validate a change
    // nobody made.
    expect((confirm.mock.calls[0]![0] as { edits?: unknown[] }).edits ?? []).toEqual([]);
  });

  it('drops an edit for an item the user deselected', async () => {
    const confirm = jest.spyOn(captureEndpoints, 'confirmCapture').mockResolvedValue(confirmation() as never);
    await reachReview();
    await fireEvent.press(screen.getByTestId('review-edit-i-1'));
    await waitFor(() => expect(screen.queryByTestId('edit-item-title')).not.toBeNull());
    await fireEvent.changeText(screen.getByTestId('edit-item-title'), 'Changed');
    await fireEvent.press(screen.getByTestId('edit-item-save'));
    await fireEvent.press(screen.getByTestId('review-item-i-1'));
    await fireEvent.press(screen.getByTestId('review-confirm'));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    // Sending it would ask the server to validate a change to something the
    // user chose not to save.
    expect((confirm.mock.calls[0]![0] as { edits?: unknown[] }).edits ?? []).toEqual([]);
  });
});
