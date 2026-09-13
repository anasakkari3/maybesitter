/**
 * Changing a proposed item before anything is saved (UC-2.4, #164).
 *
 * ── Why this asserts on the confirm, not on the sheet ────────────
 *
 * The sheet's promise is not "it holds the text you typed" — it is "what you
 * saw when you pressed Confirm is what gets written". That claim is only
 * observable at the request: an edit that lives in `state.edits` and never
 * reaches `POST /api/mobile/capture/confirm` has kept none of it. So every
 * case here drives the real screens from the tab bar, edits the item the way a
 * person does, presses Confirm, and reads the `edits` array off the endpoint
 * spy. The sheet's internal state is never inspected.
 *
 * ── It agrees with the server rather than inventing rules ────────
 *
 * `tests/contract/captureAtomicEdits.test.ts` is the authority for what an
 * edit means: a title replaces the stored one, a priority is recorded as
 * `user_explicit`, a cleared time saves the commitment unscheduled, and a time
 * in the past fails the whole confirm with `invalid_edit`. Each case below
 * names the contract test it mirrors. The client's job is to send exactly what
 * that file says is valid, and to refuse the past time while the sheet is
 * still open rather than after a button that writes.
 *
 * ── The clock and the zone are pinned ────────────────────────────
 *
 * The zone is mocked to Asia/Jerusalem so a wall clock has one instant, and
 * the times are far enough in the future that "is it past?" is not a question
 * about the day this suite runs. January is standard time there (+02:00) in
 * every year, which is what makes the expected instants below constants and
 * not a recomputation of the code under test.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { Root } from '../../../Root';
import en from '../../../i18n/locales/en.json';

import * as captureEndpoints from '../../../api/endpoints/capture';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as analyticsEndpoints from '../../../api/endpoints/analytics';
import * as trustEndpoints from '../../../api/endpoints/trust';

// Hoisted above the imports, so `src/i18n/timezone` sees it when it reaches
// for `getCalendars`. A test that ran in whatever zone the machine is in would
// assert a different instant on a laptop and in CI.
jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = {
  uid: 'edit-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

/** What the extractor proposed for the first item: 10:00 in Jerusalem. */
const PROPOSED_TIME = '2099-03-02T08:00:00.000Z';
/** What the user picks instead: 09:30 in Jerusalem, the same zone, in winter. */
const PICKED = new Date('2099-01-15T07:30:00.000Z');
const PICKED_LOCAL_HOUR = '9:30';
/** Long gone, on any day this suite is ever run. */
const IN_THE_PAST = new Date('2020-01-01T09:00:00.000Z');

/** One edit, in the shape `POST /capture/confirm` takes. */
interface SentEdit {
  itemId: string;
  title?: string;
  resolvedTime?: string | null;
  priority?: 'high' | 'normal' | 'low';
}

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;
let confirmSpy: jest.SpiedFunction<typeof captureEndpoints.confirmCapture>;

function proposal() {
  return {
    version: 'v1',
    proposalId: 'p-1',
    status: 'proposed',
    items: [
      {
        itemId: 'i-1',
        title: 'Hand in the report',
        resolvedTime: PROPOSED_TIME,
        needsClarification: false,
        // The extractor's reading, which is the thing the user is correcting.
        priority: 'normal',
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
  };
}

function confirmation() {
  return {
    success: true,
    replayed: false,
    persisted: [{ itemId: 'i-1', commitmentId: 'c-1', title: 'Hand in the report', resolvedTime: PROPOSED_TIME }],
    failed: [],
  };
}

beforeEach(() => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  // Today and the next step render behind the flow. They are not what this
  // file is about, and an unmocked call would be a network error in the tree.
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
  jest.spyOn(trustEndpoints, 'getTrust')
    .mockResolvedValue({ success: true, participantId: 'edit-user', trust: { analyticsConsent: false } } as never);
  jest.spyOn(analyticsEndpoints, 'recordAnalyticsEvent')
    .mockResolvedValue({ success: true, participantId: 'edit-user', recorded: true, eventId: 'e-1' } as never);
  jest.spyOn(captureEndpoints, 'proposeCapture').mockResolvedValue(proposal() as never);
  confirmSpy = jest.spyOn(captureEndpoints, 'confirmCapture').mockResolvedValue(confirmation() as never);
});

afterEach(() => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

/** Open the app, walk in through the tab bar, and get a proposal on screen. */
async function reachReview() {
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
  await fireEvent.changeText(screen.getByTestId('capture-input'), 'Hand in the report tomorrow at 10, and call Sami');
  await fireEvent.press(screen.getByTestId('capture-analyze'));
  await waitFor(() => expect(screen.queryByTestId('review-item-i-1')).not.toBeNull());
}

/** Press Change on a proposed card. */
async function openSheet(itemId: string) {
  await fireEvent.press(screen.getByTestId(`review-edit-${itemId}`));
  await waitFor(() => expect(screen.queryByTestId('edit-item-sheet')).not.toBeNull());
}

/**
 * Turn the wheel to an instant.
 *
 * The iOS picker hands its answer back as a timestamp on the native event,
 * which is what a spin of the wheel produces on a device; the sheet converts
 * it to the wall clock it shows.
 */
async function spinPickerTo(which: 'date' | 'time', instant: Date) {
  await fireEvent.press(screen.getByTestId(`edit-item-pick-${which}`));
  await waitFor(() => expect(screen.queryByTestId('edit-item-picker')).not.toBeNull());
  await fireEvent(
    screen.getByTestId('edit-item-picker'),
    'change',
    { nativeEvent: { timestamp: instant.getTime(), utcOffset: 0 } },
  );
}

async function pressSave() {
  await fireEvent.press(screen.getByTestId('edit-item-save'));
}

/**
 * Confirm everything, and hand back the edits the request actually carried.
 *
 * An empty array is the honest answer for "no edits": the endpoint drops the
 * field from the body when there is nothing in it, so an empty array here and
 * an absent `edits` on the wire are the same request.
 */
async function confirmAndReadEdits(): Promise<SentEdit[] | undefined> {
  await fireEvent.press(screen.getByTestId('review-confirm'));
  await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
  return (confirmSpy.mock.calls[0]![0] as { edits?: SentEdit[] }).edits;
}

describe('what the user changed is what the confirm carries', () => {
  it('sends a retyped title, and nothing they did not touch', async () => {
    // Mirrors "an edited title is what gets persisted, in the same write".
    await reachReview();
    await openSheet('i-1');
    await fireEvent.changeText(screen.getByTestId('edit-item-title'), 'Ring the clinic about the results');
    await pressSave();
    // The card shows what will be confirmed, not what the extractor said.
    await waitFor(() => expect(screen.queryByText('Ring the clinic about the results')).not.toBeNull());

    expect(await confirmAndReadEdits()).toEqual([
      { itemId: 'i-1', title: 'Ring the clinic about the results' },
    ]);
  });

  it('sends Must as the priority the server records as the user’s own', async () => {
    // The client's half of "an edited priority is recorded as the user's, not
    // as inferred": the level the person picked reaches the request. What the
    // server then does with it — `priority.level: 'high'` with
    // `source: 'user_explicit'` and pressure off — is asserted against the
    // real boundary in tests/contract/captureAtomicEdits.test.ts.
    await reachReview();
    await openSheet('i-1');
    // The button really is the one labelled Must, not a third option that
    // happens to carry the id.
    expect(screen.getByTestId('edit-item-priority-high').props.accessibilityLabel).toBe(en.todayGroupMust);
    await fireEvent.press(screen.getByTestId('edit-item-priority-high'));
    await pressSave();
    // And the guess is no longer announced as one, because it is now a fact
    // the user stated.
    await waitFor(() => expect(screen.queryByTestId('review-estimated-i-1')).toBeNull());

    expect(await confirmAndReadEdits()).toEqual([{ itemId: 'i-1', priority: 'high' }]);
  });

  it('sends a picked time as the instant that wall clock means in the device zone', async () => {
    // Mirrors "an edited time replaces both the due and the reminder instant".
    // 09:30 on a January morning in Jerusalem is 07:30Z — the constant is
    // written out rather than computed, so a zone the client got wrong is a
    // failure here instead of a round trip that agrees with itself.
    await reachReview();
    await openSheet('i-1');
    await spinPickerTo('date', PICKED);
    // The sheet shows the user their own clock while they are still in it.
    await waitFor(() => expect(screen.queryByText(new RegExp(PICKED_LOCAL_HOUR))).not.toBeNull());
    await pressSave();

    expect(await confirmAndReadEdits()).toEqual([
      { itemId: 'i-1', resolvedTime: '2099-01-15T07:30:00.000Z' },
    ]);
  });

  it('a time left alone is not sent at all', async () => {
    // An untouched field would ask the server to re-validate a value it
    // produced itself, including one that has drifted into the past while the
    // review screen was open.
    await reachReview();
    await openSheet('i-1');
    await fireEvent.changeText(screen.getByTestId('edit-item-title'), 'Hand in the report, signed');
    await pressSave();

    const sent = await confirmAndReadEdits();
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent![0]!).sort()).toEqual(['itemId', 'title']);
  });

  it('discards the change when the user leaves the sheet instead of saving', async () => {
    await reachReview();
    await openSheet('i-1');
    await fireEvent.changeText(screen.getByTestId('edit-item-title'), 'Something else entirely');
    await fireEvent.press(screen.getByTestId('edit-item-cancel'));
    await waitFor(() => expect(screen.queryByTestId('edit-item-sheet')).toBeNull());

    // The card is untouched, and so is the request.
    expect(screen.queryByText('Something else entirely')).toBeNull();
    expect(await confirmAndReadEdits()).toEqual([]);
  });
});

describe('an item with no time', () => {
  it('offers no pickers, and is confirmed without inventing one', async () => {
    await reachReview();
    await openSheet('i-2');

    // The switch is already on "No time", because that is what the item is.
    expect(screen.getByTestId('edit-item-no-time').props.value).toBe(true);
    expect(screen.queryByTestId('edit-item-pick-date')).toBeNull();
    expect(screen.queryByTestId('edit-item-pick-time')).toBeNull();

    await fireEvent.changeText(screen.getByTestId('edit-item-title'), 'Call Sami about Saturday');
    await pressSave();

    // No `resolvedTime` key at all: the user did not touch the time, and an
    // explicit null would be the "clear it" edit, which is a different one.
    expect(await confirmAndReadEdits()).toEqual([
      { itemId: 'i-2', title: 'Call Sami about Saturday' },
    ]);
  });

  it('clearing a time the extractor found sends it as no time, not as a missing field', async () => {
    // Mirrors "clearing the time saves the commitment unscheduled rather than
    // confirmed": the server can only do that if the client says `null` out
    // loud. A dropped field would leave the extractor's hour in place.
    await reachReview();
    await openSheet('i-1');
    await fireEvent(screen.getByTestId('edit-item-no-time'), 'valueChange', true);
    await waitFor(() => expect(screen.queryByTestId('edit-item-pick-date')).toBeNull());
    await pressSave();

    await waitFor(() => expect(screen.getByTestId('review-when-i-1').props.children).toBe(en.noTimeYet));
    expect(await confirmAndReadEdits()).toEqual([{ itemId: 'i-1', resolvedTime: null }]);
  });
});

describe('what the sheet refuses, while it is still open', () => {
  it('never sends a time that has already passed', async () => {
    // The server refuses this with `invalid_edit` and persists nothing — see
    // "every rule that can refuse an edit" in the contract test, case "a time
    // in the past". The sheet refuses it first so the user finds out here
    // rather than after pressing a button that writes, and the whole confirm
    // is not lost to one bad field.
    await reachReview();
    await openSheet('i-1');
    await spinPickerTo('date', IN_THE_PAST);
    await pressSave();

    await waitFor(() => expect(screen.queryByTestId('edit-item-problem')).not.toBeNull());
    expect(screen.getByTestId('edit-item-problem').props.children).toBe(en.editItemPast);
    // Still open, with the change still in it: the user has something to fix.
    expect(screen.queryByTestId('edit-item-sheet')).not.toBeNull();

    // And confirming the rest of the proposal carries no edit at all, so the
    // server is never given the chance to fail the whole write on it.
    expect(await confirmAndReadEdits()).toEqual([]);
  });

  it('will not save an empty title', async () => {
    // The same refusal as the contract test's "empty title" and
    // "whitespace-only title" cases, made before the request exists.
    await reachReview();
    await openSheet('i-1');
    await fireEvent.changeText(screen.getByTestId('edit-item-title'), '   ');
    await waitFor(() => expect(screen.queryByTestId('edit-item-problem')).not.toBeNull());
    expect(screen.getByTestId('edit-item-problem').props.children).toBe(en.editItemEmpty);
    expect(screen.getByTestId('edit-item-save').props.accessibilityState.disabled).toBe(true);

    await pressSave();
    expect(screen.queryByTestId('edit-item-sheet')).not.toBeNull();
    expect(await confirmAndReadEdits()).toEqual([]);
  });
});
