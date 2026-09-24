import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { PlanScreen } from '../../../screens/PlanScreen';
import { PlanEditRefusedError, NetworkError, QuotaExceededError, ValidationError } from '../../../api/errors';
import type { DailyPlan, PlanSettings } from '../../../api/schemas/plan';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import { withHermesIntl } from '../../../testing/hermesIntl';
import { deferred } from '../../../testing/deferred';
import { isolateAuto } from '../../../i18n/bidi';
import en from '../../../i18n/locales/en.json';
import ar from '../../../i18n/locales/ar.json';
import todayFixture from '../../../api/__fixtures__/plan.today.json';
import trustFixture from '../../../api/__fixtures__/trust.state.json';
import ackFixture from '../../../api/__fixtures__/analytics.ack.json';

import * as planEndpoints from '../../../api/endpoints/plans';
import * as trustEndpoints from '../../../api/endpoints/trust';
import * as analyticsEndpoints from '../../../api/endpoints/analytics';

/**
 * Today's plan on a device (UC-3.10b, #195).
 *
 * Every `render` and every `fireEvent` is awaited: RNTL v14 returns promises,
 * and an un-awaited one leaves the *next* case mounting nothing and passing
 * while asserting about an empty tree.
 *
 * What is not here, and cannot be: tapping the morning push on a killed app.
 * That needs #184's APNs key and a real handset. Nothing below should be read
 * as evidence for it.
 */

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const USER: AuthUser = {
  uid: 'plan-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

const DATE = '2026-08-09';

const BASE = todayFixture.plan as DailyPlan;

function planWith(over: Partial<DailyPlan> = {}): DailyPlan {
  return { ...BASE, ...over };
}

/** The trust record, with one answer changed: analytics consent. */
function trustDeciding(granted: boolean) {
  const base = trustFixture as unknown as { trust: Record<string, unknown>; whatKnows: Record<string, unknown> };
  return {
    ...base,
    trust: { ...base.trust, analyticsConsent: granted },
    whatKnows: { ...base.whatKnows, analyticsConsent: granted },
  };
}

const SETTINGS_ON: PlanSettings = {
  enabled: true, deliveryLocalTime: '07:30', timezone: 'Asia/Jerusalem', nextRunAt: '2026-08-10T04:30:00.000Z', continuousReplanEnabled: true,
};

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(async () => {
  onlineManager.setOnline(true);
  await AsyncStorage.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(planEndpoints, 'getPlan').mockResolvedValue(planWith() as never);
  jest.spyOn(planEndpoints, 'getPlanSettings').mockResolvedValue(SETTINGS_ON as never);
  jest.spyOn(planEndpoints, 'actOnPlan').mockResolvedValue(planWith({ status: 'accepted' }) as never);
  jest.spyOn(planEndpoints, 'regeneratePlan').mockResolvedValue(planWith({ generation: 2 }) as never);
  jest.spyOn(planEndpoints, 'buildPlan').mockResolvedValue(planWith({ generation: 1 }) as never);
  // The ledger append (#533) is fire-and-forget; mocked so the suite never
  // waits on it and no request escapes to the network.
  jest.spyOn(planEndpoints, 'markPlanOpened').mockResolvedValue(undefined as never);
  // The screen reads analytics consent before it reports anything (#195 step
  // 7). Declined by default, so every case above this line exercises the
  // screen without a metrics call in it — and so that the consent read is a
  // decision made here rather than a request that escapes to the network.
  jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue(trustDeciding(false) as never);
  jest.spyOn(analyticsEndpoints, 'recordAnalyticsEvent').mockResolvedValue(ackFixture as never);
});

afterEach(() => {
  client.clear();
  onlineManager.setOnline(true);
  resetAuthForTests();
  jest.restoreAllMocks();
});

async function show(date = DATE) {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}>
            <PlanScreen date={date} onBack={() => {}} />
          </QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

async function loaded() {
  await show();
  await waitFor(() => expect(screen.queryByTestId('plan-why')).not.toBeNull());
}

describe('what the plan says', () => {
  it('shows the day, the reasoning, and what goes where', async () => {
    await loaded();
    expect(screen.queryByText(en.planWhyTitle)).not.toBeNull();
    expect(screen.queryByText(isolateAuto(BASE.explanation.text))).not.toBeNull();
    for (const item of BASE.scheduled) {
      expect(screen.queryByTestId(`plan-item-${item.itemId}`)).not.toBeNull();
    }
  });

  it('does not claim a model wrote a sentence the template produced', async () => {
    // The fixture's explanation is `source: 'template'`. Badging it would be a
    // claim about provenance that is simply false, and provenance is the one
    // thing a user is entitled to be told accurately.
    await loaded();
    expect(screen.queryByTestId('plan-model-note')).toBeNull();
  });

  it('names the assistant when the assistant wrote it', async () => {
    jest.spyOn(planEndpoints, 'getPlan')
      .mockResolvedValue(planWith({ explanation: { ...BASE.explanation, source: 'model' } }) as never);
    await loaded();
    expect(screen.queryByTestId('plan-model-note')).not.toBeNull();
  });

  it('says an item is gone rather than rendering a blank row', async () => {
    // `planDto` joins titles from the commitments at read time and answers null
    // for one deleted after the plan was built.
    jest.spyOn(planEndpoints, 'getPlan').mockResolvedValue(planWith({
      scheduled: [{ ...BASE.scheduled[0]!, title: null }],
    }) as never);
    await loaded();
    expect(screen.queryAllByText(en.planRemovedItem).length).toBeGreaterThan(0);
  });

  it('explains an unplaced item in words, never as a code', async () => {
    jest.spyOn(planEndpoints, 'getPlan').mockResolvedValue(planWith({
      unscheduled: [{ itemId: 'u1', title: 'Book the train', reasonCode: 'FIXED_EVENT_CONFLICT', blockId: 'block:commitment:u1' }],
    }) as never);
    await loaded();
    expect(screen.queryByTestId('plan-kept-u1')).not.toBeNull();
    expect(screen.queryByText(en.planReasonCalendarBusy)).not.toBeNull();
    expect(screen.queryByText('FIXED_EVENT_CONFLICT')).toBeNull();
  });

  it('says nothing that reads as an accusation, anywhere on the rendered screen', async () => {
    jest.spyOn(planEndpoints, 'getPlan').mockResolvedValue(planWith({
      unscheduled: [{ itemId: 'u1', title: 'Book the train', reasonCode: 'NO_FEASIBLE_SLOT', blockId: 'block:commitment:u1' }],
    }) as never);
    await loaded();
    const rendered = JSON.stringify(screen.toJSON());
    for (const word of ['failed', 'behind', 'missed', 'should have', 'overdue']) {
      expect({ word, present: new RegExp(`\\b${word}\\b`, 'i').test(rendered) })
        .toEqual({ word, present: false });
    }
  });
});

describe('“Looks good”', () => {
  it('sends exactly one accept, however many times it is tapped', async () => {
    // Three presses in one frame, which is what a double tap on a slow phone
    // is. `disabled` alone cannot stop them: it is computed from `isPending`,
    // which is state, and the re-render that turns it on happens after all
    // three handlers have already run.
    await loaded();
    const button = screen.getByTestId('plan-accept');
    // Dispatched inside one `act`, so all three handlers run before React is
    // given a chance to re-render the button as disabled.
    await act(async () => {
      void fireEvent.press(button);
      void fireEvent.press(button);
      void fireEvent.press(button);
    });
    await waitFor(() => expect(screen.queryByTestId('plan-accepted')).not.toBeNull());
    expect(planEndpoints.actOnPlan).toHaveBeenCalledTimes(1);
    expect(planEndpoints.actOnPlan).toHaveBeenCalledWith(DATE, { action: 'accept' });
  });

  it('is still sendable after one that failed', async () => {
    // The guard must not be a one-way door: an accept that never reached the
    // server has to be retryable, or a moment of bad signal costs the user the
    // ability to accept their own plan for the rest of the day.
    jest.spyOn(planEndpoints, 'actOnPlan').mockRejectedValueOnce(new NetworkError('no signal') as never);
    await loaded();
    await fireEvent.press(screen.getByTestId('plan-accept'));
    await waitFor(() => expect(planEndpoints.actOnPlan).toHaveBeenCalledTimes(1));
    await fireEvent.press(screen.getByTestId('plan-accept'));
    await waitFor(() => expect(screen.queryByTestId('plan-accepted')).not.toBeNull());
    expect(planEndpoints.actOnPlan).toHaveBeenCalledTimes(2);
  });

  it('confirms what just happened, and stops offering it', async () => {
    await loaded();
    await fireEvent.press(screen.getByTestId('plan-accept'));
    await waitFor(() => expect(screen.queryByText(en.planAcceptedToast)).not.toBeNull());
    expect(screen.getByTestId('plan-accept').props.accessibilityState.disabled).toBe(true);
  });

  it('shows as accepted on a fresh launch, from the server’s own record', async () => {
    // Nothing is persisted on the device, so "after relaunch" is: a cold client
    // asks, and the route answers `status: 'accepted'`.
    jest.spyOn(planEndpoints, 'getPlan')
      .mockResolvedValue(planWith({ status: 'accepted', acceptedAt: '2026-08-09T06:00:00.000Z' }) as never);
    await loaded();
    // A status, not a confirmation: nothing just happened, and "Plan saved for
    // today" about something done yesterday morning would read as an event.
    expect(screen.queryByText(en.planAcceptedStatus)).not.toBeNull();
    expect(screen.queryByText(en.planAcceptedToast)).toBeNull();
    expect(screen.getByTestId('plan-accept').props.accessibilityState.disabled).toBe(true);
  });

  it('sets the plan aside without touching a commitment', async () => {
    jest.spyOn(planEndpoints, 'actOnPlan').mockResolvedValue(planWith({ status: 'dismissed' }) as never);
    await loaded();
    await fireEvent.press(screen.getByTestId('plan-dismiss'));
    await waitFor(() => expect(screen.queryByTestId('plan-dismissed')).not.toBeNull());
    expect(planEndpoints.actOnPlan).toHaveBeenCalledWith(DATE, { action: 'dismiss' });
  });
});

describe('moving an item the plan will not allow', () => {
  const ITEM = BASE.scheduled[0]!;

  async function openEditor() {
    await loaded();
    await fireEvent.press(screen.getByTestId(`plan-open-${ITEM.itemId}`));
    await waitFor(() => expect(screen.queryByTestId(`plan-pick-${ITEM.itemId}`)).not.toBeNull());
    await fireEvent.press(screen.getByTestId(`plan-pick-${ITEM.itemId}`));
    await waitFor(() => expect(screen.queryByTestId(`plan-picker-${ITEM.itemId}`)).not.toBeNull());
  }

  /**
   * The wheel's answer: three hours later **on the face the wheel is showing**.
   *
   * Not `ITEM.startsAt + 3h`, which is what this was and which made the whole
   * case depend on the zone the suite happened to run in. The wheel draws the
   * *device's* clock, and `PlanScreen` reads whatever face it is left on as a
   * device wall clock and converts that into an instant in the *plan's* zone.
   * So an instant pushed in here is read as a wall clock and converted back —
   * and when the device sits exactly three hours behind the plan's zone, the
   * round trip lands on the item's own time and the "move" moves nothing. The
   * item's row then never changes, and the assertion below waits out its
   * budget reading the time it started with.
   *
   * That is one offset, out of all of them: this passed in Asia/Hebron (+03,
   * the fixture's own offset) and in America/Los_Angeles, and failed in UTC —
   * which is what CI runs in.
   *
   * Three hours added to the wheel's own value is three hours of *device* wall
   * clock, which is three hours of plan-zone instant in every zone. Added with
   * a local setter, the same way `pickerClock.ts` reads the wheel, so it stays
   * wall-clock arithmetic rather than instant arithmetic across a DST edge.
   */
  async function pickThreeHoursLater() {
    // The face is built from what the *row* says — which is the item's time in
    // the plan's zone, the same reading the wheel is opened on — plus the
    // plan's own date, with local setters, exactly as `pickerClock.ts` reads
    // one back. Nothing here is computed with the app's own conversions, and
    // nothing depends on the machine's zone.
    //
    // It assumes the turn does not cross midnight on the wheel: the fixture
    // sits at 12:00, so this lands on 15:00. A fixture moved late enough to
    // roll over would break the "exactly three hours" case below rather than
    // quietly change what this means.
    // The row shows a range ("11:00–12:00") when the placement has a length
    // and a single time when it does not — the component says so itself. This
    // reads the *start*, which is the face the wheel is opened on either way.
    // Splitting the whole label on ":" read the range's minutes as NaN, left
    // the wheel on an invalid date, and disabled the button the case is about:
    // the test failed with "actOnPlan was never called", which is not a thing
    // a reader would connect to a fixture that gained a duration.
    const label = String(screen.getByTestId(`plan-item-time-${ITEM.itemId}`).props.children);
    const shown = /(\d{1,2}):(\d{2})/.exec(label);
    if (!shown) throw new Error(`the row shows no time to turn the wheel from: ${label}`);
    const [hour, minute] = [Number(shown[1]), Number(shown[2])];
    const [year, month, day] = DATE.split('-').map(Number) as [number, number, number];
    const face = new Date();
    face.setFullYear(year, month - 1, day);
    face.setHours(hour + 3, minute, 0, 0);
    // The real component's own `onChange` contract, not a shape this file
    // invented: `@react-native-community/datetimepicker` is what the app ships.
    await fireEvent(screen.getByTestId(`plan-picker-${ITEM.itemId}`), 'change', {
      type: 'set',
      nativeEvent: { timestamp: face.getTime() },
    });
  }

  /** The move the screen actually sent, whatever the wheel was asked for. */
  function moveSent(): { itemId: string; startsAt: string; endsAt: string } {
    const [, body] = (planEndpoints.actOnPlan as jest.Mock).mock.calls[0] as [
      string, { moves?: { itemId: string; startsAt: string; endsAt: string }[] },
    ];
    return body.moves![0]!;
  }

  it('puts the item back where it was, and says why, when the time is taken', async () => {
    // The request is held open for the whole of the optimistic half: it cannot
    // settle until this test rejects it, so "the move is on screen and the
    // refusal has not arrived" is a state held rather than a window to catch.
    const move = deferred<never>();
    jest.spyOn(planEndpoints, 'actOnPlan').mockReturnValue(move.promise as never);

    await openEditor();
    const before = screen.getByTestId(`plan-item-time-${ITEM.itemId}`).props.children;
    await pickThreeHoursLater();
    await fireEvent.press(screen.getByTestId(`plan-move-${ITEM.itemId}`));

    await waitFor(() => expect(planEndpoints.actOnPlan).toHaveBeenCalled());

    // The pick is a move at all. This comes first because it is the one thing
    // waiting cannot establish: a wheel value that converted back onto the
    // item's own time would leave the row unchanged for ever, and the wait
    // below would then spend its budget and report the *screen* as broken.
    // That is exactly how a zone-dependent wheel value read as a defect in the
    // optimistic update for an afternoon.
    expect(moveSent().startsAt).not.toBe(ITEM.startsAt);

    // The move lands under the finger first — that is the optimistic half, and
    // without it there would be nothing for the rollback to undo.
    //
    // Waiting is sound here, and only here, *because the request is held
    // open*: the optimistic state cannot close on its own, so this waits for
    // something to become true and stay true rather than racing a window shut.
    // A bare assertion is not enough — the cache write is already done by the
    // time the request goes out, but TanStack notifies its observers through a
    // batch the React tree has not necessarily drained yet.
    await waitFor(() =>
      expect(screen.getByTestId(`plan-item-time-${ITEM.itemId}`).props.children).not.toBe(before));

    move.reject(new PlanEditRefusedError('overlaps_fixed_event', ITEM.itemId));

    await waitFor(() =>
      expect(screen.queryByTestId(`plan-item-refused-${ITEM.itemId}`)).not.toBeNull());
    // The localized reason, under the row it is about.
    expect(screen.queryByText(en.planEditBusy)).not.toBeNull();
    // And the item is back at the time it had before the drag.
    expect(screen.getByTestId(`plan-item-time-${ITEM.itemId}`).props.children).toBe(before);
  });

  it('moves the item by the hours the wheel was turned, in any zone', async () => {
    // The guard on the case above, and the reason it can no longer pass by
    // accident: three hours on the wheel is three hours in the plan's zone
    // whatever clock the machine running this is set to.
    await openEditor();
    await pickThreeHoursLater();
    await fireEvent.press(screen.getByTestId(`plan-move-${ITEM.itemId}`));
    await waitFor(() => expect(planEndpoints.actOnPlan).toHaveBeenCalled());
    expect(Date.parse(moveSent().startsAt) - Date.parse(ITEM.startsAt)).toBe(3 * 3_600_000);
  });

  it('sends the move with the length the planner gave it', async () => {
    await openEditor();
    await pickThreeHoursLater();
    await fireEvent.press(screen.getByTestId(`plan-move-${ITEM.itemId}`));
    await waitFor(() => expect(planEndpoints.actOnPlan).toHaveBeenCalled());
    const sent = moveSent();
    const length = Date.parse(sent.endsAt) - Date.parse(sent.startsAt);
    expect(length).toBe(Date.parse(ITEM.endsAt) - Date.parse(ITEM.startsAt));
  });

  it('sends one edit per tap, however many times it is tapped', async () => {
    // Two optimistic edits in flight would have rollbacks that restore each
    // other's intermediate state.
    await loaded();
    await fireEvent.press(screen.getByTestId(`plan-open-${ITEM.itemId}`));
    await waitFor(() => expect(screen.queryByTestId(`plan-remove-${ITEM.itemId}`)).not.toBeNull());
    const button = screen.getByTestId(`plan-remove-${ITEM.itemId}`);
    await act(async () => {
      void fireEvent.press(button);
      void fireEvent.press(button);
    });
    await waitFor(() => expect(planEndpoints.actOnPlan).toHaveBeenCalled());
    expect(planEndpoints.actOnPlan).toHaveBeenCalledTimes(1);
  });

  it('says so somewhere when the refusal names an item it is not showing', async () => {
    // `unknown_item` is the server saying "that is not in the plan I hold" —
    // another device rebuilt between this screen's read and this tap. There is
    // then no row for the sentence to sit under, and keying the page-level
    // refusal off `itemId === null` alone made the whole failure invisible.
    jest.spyOn(planEndpoints, 'actOnPlan')
      .mockRejectedValue(new PlanEditRefusedError('unknown_item', 'gone-from-this-plan') as never);
    await loaded();
    await fireEvent.press(screen.getByTestId(`plan-open-${ITEM.itemId}`));
    await waitFor(() => expect(screen.queryByTestId(`plan-remove-${ITEM.itemId}`)).not.toBeNull());
    await fireEvent.press(screen.getByTestId(`plan-remove-${ITEM.itemId}`));
    await waitFor(() => expect(screen.queryByTestId('plan-edit-refused')).not.toBeNull());
    expect(screen.queryByText(en.planEditGone)).not.toBeNull();
  });

  it('takes an item off the day when asked', async () => {
    await loaded();
    await fireEvent.press(screen.getByTestId(`plan-open-${ITEM.itemId}`));
    await waitFor(() => expect(screen.queryByTestId(`plan-remove-${ITEM.itemId}`)).not.toBeNull());
    await fireEvent.press(screen.getByTestId(`plan-remove-${ITEM.itemId}`));
    await waitFor(() =>
      expect(planEndpoints.actOnPlan).toHaveBeenCalledWith(DATE, { action: 'edit', removals: [ITEM.itemId] }));
  });

  it('does not explain a lost connection as a refused placement', async () => {
    // "That time is already taken" about a request that never reached a server
    // would be a confident lie about the user's own calendar.
    jest.spyOn(planEndpoints, 'actOnPlan').mockRejectedValue(new NetworkError('no signal') as never);
    await openEditor();
    await pickThreeHoursLater();
    await fireEvent.press(screen.getByTestId(`plan-move-${ITEM.itemId}`));
    await waitFor(() => expect(screen.queryByTestId('plan-edit-error')).not.toBeNull());
    expect(screen.queryByText(en.errorsNetwork)).not.toBeNull();
    expect(screen.queryByTestId(`plan-item-refused-${ITEM.itemId}`)).toBeNull();
  });
});

describe('asking for a new plan', () => {
  it('says how many are left, counting from the generation the plan carries', async () => {
    await loaded();
    // The morning build is generation 1 and the server allows five documents a
    // day, so four rebuilds remain.
    expect(screen.queryByTestId('plan-regenerate-left')).not.toBeNull();
    expect(screen.getByTestId('plan-regenerate-left').props.children).toContain('4');
    expect(screen.getByTestId('plan-regenerate').props.accessibilityState.disabled).toBe(false);
  });

  it('spends one generation per tap, however many times it is tapped', async () => {
    // The expensive one: each rebuild is a model call and burns one of the
    // day's four generations.
    await loaded();
    const button = screen.getByTestId('plan-regenerate');
    await act(async () => {
      void fireEvent.press(button);
      void fireEvent.press(button);
      void fireEvent.press(button);
    });
    await waitFor(() => expect(planEndpoints.regeneratePlan).toHaveBeenCalled());
    expect(planEndpoints.regeneratePlan).toHaveBeenCalledTimes(1);
  });

  it('rebuilds, and shows the plan that came back', async () => {
    await loaded();
    await fireEvent.press(screen.getByTestId('plan-regenerate'));
    await waitFor(() => expect(planEndpoints.regeneratePlan).toHaveBeenCalledWith(DATE));
    await waitFor(() =>
      expect(screen.getByTestId('plan-regenerate-left').props.children).toContain('3'));
  });

  it('stops offering it once the day’s rebuilds are spent', async () => {
    jest.spyOn(planEndpoints, 'getPlan').mockResolvedValue(planWith({ generation: 5 }) as never);
    await loaded();
    expect(screen.getByTestId('plan-regenerate').props.accessibilityState.disabled).toBe(true);
    expect(screen.queryByTestId('plan-regenerate-capped')).not.toBeNull();
    expect(screen.queryByTestId('plan-regenerate-left')).toBeNull();
  });

  it('is still offered on the last one', async () => {
    jest.spyOn(planEndpoints, 'getPlan').mockResolvedValue(planWith({ generation: 4 }) as never);
    await loaded();
    expect(screen.getByTestId('plan-regenerate').props.accessibilityState.disabled).toBe(false);
  });

  it('accepts the server’s answer when another device spent the last one', async () => {
    // The screen's own count can be one tap out of date: two phones, one
    // account. The 429 is the second line, and it says the same thing.
    jest.spyOn(planEndpoints, 'regeneratePlan')
      .mockRejectedValue(new QuotaExceededError('user_daily', 60) as never);
    await loaded();
    await fireEvent.press(screen.getByTestId('plan-regenerate'));
    await waitFor(() => expect(screen.queryByTestId('plan-regenerate-capped')).not.toBeNull());
    expect(screen.getByTestId('plan-regenerate').props.accessibilityState.disabled).toBe(true);
  });
});

describe('with no signal', () => {
  it('keeps a plan already fetched, read-only, with a line saying so', async () => {
    await loaded();
    await act(async () => { onlineManager.setOnline(false); });
    await waitFor(() => expect(screen.queryByTestId('plan-offline-readonly')).not.toBeNull());
    // Still on screen — it is in memory, and that is the whole point of
    // keeping it there.
    expect(screen.queryByText(isolateAuto(BASE.explanation.text))).not.toBeNull();
    for (const id of ['plan-accept', 'plan-dismiss', 'plan-regenerate']) {
      expect(screen.getByTestId(id).props.accessibilityState.disabled).toBe(true);
    }
  });

  it('will not open an editor on a plan it cannot write to', async () => {
    await loaded();
    await act(async () => { onlineManager.setOnline(false); });
    await waitFor(() => expect(screen.queryByTestId('plan-offline-readonly')).not.toBeNull());
    await fireEvent.press(screen.getByTestId(`plan-open-${BASE.scheduled[0]!.itemId}`));
    expect(screen.queryByTestId(`plan-pick-${BASE.scheduled[0]!.itemId}`)).toBeNull();
  });

  it('says so on a cold start, rather than spinning forever', async () => {
    // React Query *pauses* a query when it is offline rather than failing it,
    // so without this the screen would show a loading indicator to somebody on
    // a train, with no error and no end.
    await act(async () => { onlineManager.setOnline(false); });
    await show();
    await waitFor(() => expect(screen.queryByTestId('plan-offline-cold')).not.toBeNull());
    expect(screen.queryByTestId('query-loading')).toBeNull();
  });
});

describe('when there is no plan for the day', () => {
  const SETTINGS_OFF: PlanSettings = { ...SETTINGS_ON, enabled: false, nextRunAt: null };

  beforeEach(() => {
    jest.spyOn(planEndpoints, 'getPlan').mockResolvedValue(null as never);
  });

  /** The empty state, once the settings answer has landed too. */
  async function empty() {
    await show();
    await waitFor(() => expect(screen.queryByTestId('plan-empty')).not.toBeNull());
    await waitFor(() => expect(planEndpoints.getPlanSettings).toHaveBeenCalled());
  }

  it('says so instead of showing an error with a Retry that cannot help', async () => {
    await empty();
    expect(screen.queryByTestId('query-error')).toBeNull();
  });

  it('offers to build today’s plan, and does not tell somebody to turn on what they already have on', async () => {
    await empty();
    await waitFor(() => expect(screen.queryByText(en.planEmptyBodyReady)).not.toBeNull());
    expect(screen.queryByTestId('plan-build')).not.toBeNull();
    expect(screen.queryByText(en.planEmptyBuildCta)).not.toBeNull();
    expect(screen.queryByText(en.planEmptyBody)).toBeNull();
    expect(screen.queryByTestId('plan-enable-morning')).toBeNull();
  });

  it('with the morning plan off, offers the build and still the way to turn it on', async () => {
    jest.spyOn(planEndpoints, 'getPlanSettings').mockResolvedValue(SETTINGS_OFF as never);
    await empty();
    await waitFor(() => expect(screen.queryByTestId('plan-enable-morning')).not.toBeNull());
    expect(screen.queryByTestId('plan-build')).not.toBeNull();
    expect(screen.queryByText(en.planEmptyBody)).not.toBeNull();
    expect(screen.queryByText(en.planEmptyBodyReady)).toBeNull();
  });

  it('sends one build, however many times it is tapped', async () => {
    const answer = deferred<DailyPlan>();
    jest.spyOn(planEndpoints, 'buildPlan').mockReturnValue(answer.promise as never);
    await empty();
    const button = screen.getByTestId('plan-build');
    await act(async () => {
      void fireEvent.press(button);
      void fireEvent.press(button);
      void fireEvent.press(button);
    });
    await waitFor(() => expect(planEndpoints.buildPlan).toHaveBeenCalled());
    expect(planEndpoints.buildPlan).toHaveBeenCalledTimes(1);
    await act(async () => { answer.resolve(planWith()); });
  });

  it('builds, and shows the plan that came back in place', async () => {
    await empty();
    await fireEvent.press(screen.getByTestId('plan-build'));
    await waitFor(() => expect(planEndpoints.buildPlan).toHaveBeenCalledWith(DATE));
    await waitFor(() => expect(screen.queryByTestId('plan-why')).not.toBeNull());
    expect(screen.queryByTestId('plan-empty')).toBeNull();
    // Generation 1: all four of the day's rebuilds are still there.
    expect(screen.getByTestId('plan-regenerate-left').props.children).toContain('4');
  });

  it('says what went wrong in words, and can be tried again', async () => {
    jest.spyOn(planEndpoints, 'buildPlan').mockRejectedValueOnce(new NetworkError('no signal') as never);
    await empty();
    await fireEvent.press(screen.getByTestId('plan-build'));
    await waitFor(() => expect(screen.queryByTestId('plan-build-error')).not.toBeNull());
    expect(screen.queryByText(en.errorsNetwork)).not.toBeNull();
    await fireEvent.press(screen.getByTestId('plan-build'));
    await waitFor(() => expect(planEndpoints.buildPlan).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('plan-why')).not.toBeNull());
  });

  it('says a date it may not build for in plain words, never as the reason code', async () => {
    // A deep link can carry any date; the server builds only the account's
    // today or tomorrow and answers 400 `date_out_of_range` otherwise.
    jest.spyOn(planEndpoints, 'buildPlan')
      .mockRejectedValue(new ValidationError('a plan can only be built for today or tomorrow', 'date_out_of_range') as never);
    await empty();
    await fireEvent.press(screen.getByTestId('plan-build'));
    await waitFor(() => expect(screen.queryByTestId('plan-build-error')).not.toBeNull());
    expect(screen.queryByText(en.errorsValidation)).not.toBeNull();
    expect(screen.queryByText(/date_out_of_range|today or tomorrow/)).toBeNull();
  });

  it('offers no build with no signal, and says why', async () => {
    await empty();
    await act(async () => { onlineManager.setOnline(false); });
    await waitFor(() => expect(screen.queryByTestId('plan-build')).toBeNull());
    expect(screen.queryByText(en.planOfflineCold)).not.toBeNull();
  });

  it('offers no build on a cold start with no signal', async () => {
    await act(async () => { onlineManager.setOnline(false); });
    await show();
    await waitFor(() => expect(screen.queryByTestId('plan-offline-cold')).not.toBeNull());
    expect(screen.queryByTestId('plan-build')).toBeNull();
  });

  it('shows a real failure as one, with a retry', async () => {
    jest.spyOn(planEndpoints, 'getPlan').mockRejectedValue(new NetworkError('no signal') as never);
    await show();
    await waitFor(() => expect(screen.queryByTestId('query-error')).not.toBeNull());
    expect(screen.queryByText(en.errorsNetwork)).not.toBeNull();
    expect(screen.queryByTestId('plan-build')).toBeNull();
  });

  it('says it in Arabic too, without telling anyone to switch on what is on', async () => {
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
    await empty();
    await waitFor(() => expect(screen.queryByText(ar.planEmptyBuildCta)).not.toBeNull());
    expect(screen.queryByText(ar.planEmptyBodyReady)).not.toBeNull();
    expect(screen.queryByText(ar.planEmptyBody)).toBeNull();
  });
});

describe('the clock on screen is the plan’s, not the phone’s', () => {
  /**
   * A zone no host is ever set to, and a fixed +14:00 offset with no DST.
   *
   * The host running this suite is in Asia/Hebron; a fixture in Asia/Jerusalem
   * would render identically whether the code used the plan's zone or the
   * device's, and the test would agree with a broken conversion. Kiritimati
   * cannot: 09:00 UTC is 23:00 there and 12:00 here.
   */
  it('reads a start time in the zone the plan was built for', async () => {
    jest.spyOn(planEndpoints, 'getPlan').mockResolvedValue(planWith({
      timezone: 'Pacific/Kiritimati',
      scheduled: [{
        itemId: 'k1', title: 'Write the summary', blockId: 'block:commitment:k1',
        startsAt: '2026-08-09T09:00:00.000Z', endsAt: '2026-08-09T09:00:00.000Z',
      }],
    }) as never);

    await withHermesIntl(async () => {
      await loaded();
      // +14:00, hand-computed from a zone that has never observed DST — not
      // read back out of the same Intl call the screen makes.
      expect(screen.getByTestId('plan-item-time-k1').props.children).toBe('23:00');
    });
  });
});

describe('nothing about the plan reaches the disk', () => {
  it('leaves no title, explanation or plan key in device storage', async () => {
    // #157's rule, and the reason there is no query persister: an unencrypted
    // copy of somebody's day surviving until they clear app data is not a
    // trade this product makes. A cold start with no data is the price.
    //
    // Every write is recorded *and passed through*, rather than spied on with
    // `jest.spyOn`: the AsyncStorage jest mock's methods are already `jest.fn`s
    // carrying the library's own implementation, and restoring a spy over one
    // resets that implementation away — which silently turns the rest of this
    // file's storage into a no-op.
    const writes: string[] = [];
    const store = AsyncStorage as unknown as {
      setItem: (key: string, value: string) => Promise<void>;
      multiSet: (pairs: [string, string][]) => Promise<void>;
      mergeItem: (key: string, value: string) => Promise<void>;
    };
    const original = { setItem: store.setItem, multiSet: store.multiSet, mergeItem: store.mergeItem };
    store.setItem = (key, value) => { writes.push(`${key}=${value}`); return original.setItem(key, value); };
    store.multiSet = pairs => { for (const [k, v] of pairs) writes.push(`${k}=${v}`); return original.multiSet(pairs); };
    store.mergeItem = (key, value) => { writes.push(`${key}=${value}`); return original.mergeItem(key, value); };

    try {
      await loaded();
      await fireEvent.press(screen.getByTestId('plan-accept'));
      await waitFor(() => expect(screen.queryByTestId('plan-accepted')).not.toBeNull());
      await fireEvent.press(screen.getByTestId(`plan-open-${BASE.scheduled[0]!.itemId}`));
    } finally {
      Object.assign(store, original);
    }

    // Recorded writes, so something written and then deleted is still caught.
    const everything = writes.join('\n');
    for (const secret of [
      BASE.explanation.text,
      ...BASE.scheduled.map(item => item.title ?? ''),
      ...BASE.scheduled.map(item => item.itemId),
      BASE.inputDigest,
      DATE,
    ]) {
      expect({ secret, stored: everything.includes(secret) }).toEqual({ secret, stored: false });
    }

    // And the store as it actually stands: no plan key, and no plan content
    // under a key of any other name.
    const keys = await AsyncStorage.getAllKeys();
    expect(keys.filter(key => /plan/i.test(key))).toEqual([]);
    const values = (await AsyncStorage.multiGet(keys)).map(([, value]) => value ?? '').join('\n');
    expect(values).not.toContain(BASE.explanation.text);
    expect(values).not.toContain(BASE.scheduled[0]!.title);
  });
});

describe('right to left', () => {
  it('renders in Arabic, in Arabic', async () => {
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
    await show();
    // The stored preference is read in an effect, so the first frame is the
    // device language; wait for the one the user actually chose.
    await waitFor(() => expect(screen.queryByText(ar.planWhyTitle)).not.toBeNull());
    expect(screen.queryByText(en.planWhyTitle)).toBeNull();
    expect(screen.queryByText(ar.planAccept)).not.toBeNull();
    expect(screen.queryByText(ar.planKeptTitle)).toBeNull(); // no unplaced items in the fixture
  });

  it('sets every line right to left and aligns it to the start', async () => {
    // `direction: 'rtl'` itself is set once, on Root's own view. What this
    // screen owes is text that reads the right way inside it — which `Txt`
    // decides per line, and which a hard-coded `textAlign: 'left'` anywhere in
    // this file would silently break.
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
    await show();
    await waitFor(() => expect(screen.queryByText(ar.planWhyTitle)).not.toBeNull());

    const title = screen.getByText(ar.planWhyTitle);
    const style = Array.isArray(title.props.style) ? title.props.style[0] : title.props.style;
    expect(style.writingDirection).toBe('rtl');
    // Fabric resolves this logical edge to the right under inherited RTL.
    expect(style.textAlign).toBe('left');
  });

  it('matches the Arabic layout it was reviewed in', async () => {
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
    await show();
    await waitFor(() => expect(screen.queryByText(ar.planWhyTitle)).not.toBeNull());
    // Deterministic: every instant in the tree comes from the committed
    // fixture and every time is read in the plan's own zone, so nothing here
    // depends on when or where the suite runs.
    expect(screen.toJSON()).toMatchSnapshot();
  });
});

describe('what the screen reports about what somebody did', () => {
  /** Every analytics call the screen has made, as `[eventName, properties]`. */
  function reported(): [string, Record<string, unknown>][] {
    return (analyticsEndpoints.recordAnalyticsEvent as jest.Mock).mock.calls as [string, Record<string, unknown>][];
  }

  function names(): string[] {
    return reported().map(([eventName]) => eventName);
  }

  function propertiesOf(eventName: string): Record<string, unknown> | undefined {
    return reported().find(([name]) => name === eventName)?.[1];
  }

  describe('when analytics consent has not been granted', () => {
    it('reports nothing at all, however much is done on the screen', async () => {
      // The server drops events for a user who declined. It cannot drop a
      // request it was never sent, which is why the gate is also here.
      await loaded();
      await fireEvent.press(screen.getByTestId('plan-accept'));
      await waitFor(() => expect(screen.queryByTestId('plan-accepted')).not.toBeNull());
      await fireEvent.press(screen.getByTestId('plan-regenerate'));
      await waitFor(() => expect(planEndpoints.regeneratePlan).toHaveBeenCalled());
      expect(names()).toEqual([]);
    });

    it('treats a consent read that did not land as a decline', async () => {
      jest.spyOn(trustEndpoints, 'getTrust').mockRejectedValue(new NetworkError('no signal') as never);
      await loaded();
      await fireEvent.press(screen.getByTestId('plan-accept'));
      await waitFor(() => expect(screen.queryByTestId('plan-accepted')).not.toBeNull());
      expect(names()).toEqual([]);
    });
  });

  describe('when it has', () => {
    beforeEach(() => {
      jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue(trustDeciding(true) as never);
    });

    it('records the plan being put on screen, once', async () => {
      // Once per plan the screen shows — not once per render. Accepting and
      // rebuilding each replace the cached plan with a new object and
      // re-render this component, and a second `plan_opened` there would read
      // as somebody coming back to a screen they never left.
      //
      // Two whole round trips are driven before the count is read, rather than
      // one: `plan_opened` is reported behind an awaited consent read, so it
      // lands a microtask *after* the render that caused it. Asserting
      // straight after the first one let a mutant keyed on the plan object
      // through — the extra event was on its way, and simply had not arrived.
      await loaded();
      await waitFor(() => expect(names()).toContain('plan_opened'));
      await fireEvent.press(screen.getByTestId('plan-accept'));
      await waitFor(() => expect(names()).toContain('plan_accepted'));
      await fireEvent.press(screen.getByTestId('plan-regenerate'));
      await waitFor(() => expect(names()).toContain('plan_regenerated'));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(names().filter(name => name === 'plan_opened')).toHaveLength(1);
      expect(propertiesOf('plan_opened')).toEqual({
        generation: 1,
        scheduledCount: BASE.scheduled.length,
        unscheduledCount: 0,
        explanationSource: 'template',
        status: 'proposed',
      });
    });

    it('names the decision, from the plan the server answered with', async () => {
      await loaded();
      await fireEvent.press(screen.getByTestId('plan-accept'));
      await waitFor(() => expect(names()).toContain('plan_accepted'));
      expect(propertiesOf('plan_accepted')).toEqual({
        generation: 1, scheduledCount: BASE.scheduled.length, unscheduledCount: 0,
      });
    });

    it('records a dismissal as a dismissal', async () => {
      jest.spyOn(planEndpoints, 'actOnPlan').mockResolvedValue(planWith({ status: 'dismissed' }) as never);
      await loaded();
      await fireEvent.press(screen.getByTestId('plan-dismiss'));
      await waitFor(() => expect(names()).toContain('plan_dismissed'));
      expect(names()).not.toContain('plan_accepted');
    });

    it('records the generation the rebuild produced, not the one it replaced', async () => {
      await loaded();
      await fireEvent.press(screen.getByTestId('plan-regenerate'));
      await waitFor(() => expect(names()).toContain('plan_regenerated'));
      expect(propertiesOf('plan_regenerated')).toEqual({ generation: 2 });
    });

    it('records a refused move with the reason the plan gave', async () => {
      // The refusals are the point. A count of only the edits that worked
      // would answer "how often does the planner refuse what people try to
      // do" with a number that cannot go up.
      const item = BASE.scheduled[0]!;
      jest.spyOn(planEndpoints, 'actOnPlan')
        .mockRejectedValue(new PlanEditRefusedError('overlaps_fixed_event', item.itemId) as never);
      await loaded();
      await fireEvent.press(screen.getByTestId(`plan-open-${item.itemId}`));
      await waitFor(() => expect(screen.queryByTestId(`plan-remove-${item.itemId}`)).not.toBeNull());
      await fireEvent.press(screen.getByTestId(`plan-remove-${item.itemId}`));
      await waitFor(() => expect(names()).toContain('plan_edited'));
      expect(propertiesOf('plan_edited')).toEqual({
        movedCount: 0, removedCount: 1, outcome: 'refused', reason: 'overlaps_fixed_event',
      });
    });

    it('records an edit the plan allowed as one that worked', async () => {
      const item = BASE.scheduled[0]!;
      await loaded();
      await fireEvent.press(screen.getByTestId(`plan-open-${item.itemId}`));
      await waitFor(() => expect(screen.queryByTestId(`plan-remove-${item.itemId}`)).not.toBeNull());
      await fireEvent.press(screen.getByTestId(`plan-remove-${item.itemId}`));
      await waitFor(() => expect(names()).toContain('plan_edited'));
      expect(propertiesOf('plan_edited')).toEqual({
        movedCount: 0, removedCount: 1, outcome: 'applied', reason: 'none',
      });
    });

    it('says nothing about an edit that never reached the plan', async () => {
      const item = BASE.scheduled[0]!;
      jest.spyOn(planEndpoints, 'actOnPlan').mockRejectedValue(new NetworkError('no signal') as never);
      await loaded();
      await fireEvent.press(screen.getByTestId(`plan-open-${item.itemId}`));
      await waitFor(() => expect(screen.queryByTestId(`plan-remove-${item.itemId}`)).not.toBeNull());
      await fireEvent.press(screen.getByTestId(`plan-remove-${item.itemId}`));
      await waitFor(() => expect(screen.queryByTestId('plan-edit-error')).not.toBeNull());
      expect(names()).not.toContain('plan_edited');
    });

    it('carries no title, item id, explanation or date in any of it', async () => {
      // The same rule as the AsyncStorage assertion above, on the other way
      // out of the device. An `itemId` in a plan is a commitment id.
      //
      // The edit comes before the accept, in that order, because accepting
      // settles the plan and an accepted plan is not editable from here.
      const item = BASE.scheduled[0]!;
      jest.spyOn(planEndpoints, 'actOnPlan')
        .mockResolvedValueOnce(planWith({ scheduled: BASE.scheduled.slice(1) }) as never)
        .mockResolvedValue(planWith({ status: 'accepted' }) as never);
      await loaded();
      await fireEvent.press(screen.getByTestId(`plan-open-${item.itemId}`));
      await waitFor(() => expect(screen.queryByTestId(`plan-remove-${item.itemId}`)).not.toBeNull());
      await fireEvent.press(screen.getByTestId(`plan-remove-${item.itemId}`));
      await waitFor(() => expect(names()).toContain('plan_edited'));
      await fireEvent.press(screen.getByTestId('plan-accept'));
      await waitFor(() => expect(names()).toContain('plan_accepted'));

      const serialized = JSON.stringify(reported());
      for (const secret of [
        BASE.explanation.text,
        BASE.inputDigest,
        DATE,
        ...BASE.scheduled.map(entry => entry.title ?? ''),
        ...BASE.scheduled.map(entry => entry.itemId),
      ]) {
        expect({ secret, sent: serialized.includes(secret) }).toEqual({ secret, sent: false });
      }
      expect(names().length).toBeGreaterThan(2);
    });

    it('lets the accept land even when the analytics route is down', async () => {
      // A metrics ping that fell over must never become a failed accept.
      jest.spyOn(analyticsEndpoints, 'recordAnalyticsEvent')
        .mockRejectedValue(new NetworkError('no signal') as never);
      await loaded();
      await fireEvent.press(screen.getByTestId('plan-accept'));
      await waitFor(() => expect(screen.queryByTestId('plan-accepted')).not.toBeNull());
      expect(screen.queryByText(en.planAcceptedToast)).not.toBeNull();
      expect(screen.queryByTestId('plan-edit-error')).toBeNull();
    });
  });

  describe('the ledger append (#533)', () => {
    it('records the plan being put on screen, once, whatever the analytics consent', async () => {
      // The same once-per-shown-plan discipline as the analytics event, but
      // none of its gate: this row is the user's own ledger, not metrics, and
      // R3 cannot learn from a record consent never let exist. Default consent
      // here is declined — the append must happen anyway.
      await loaded();
      await waitFor(() => expect(planEndpoints.markPlanOpened).toHaveBeenCalledWith(DATE));
      await fireEvent.press(screen.getByTestId('plan-accept'));
      await waitFor(() => expect(screen.queryByTestId('plan-accepted')).not.toBeNull());
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(planEndpoints.markPlanOpened).toHaveBeenCalledTimes(1);
    });

    it('lets the screen work when the append fails', async () => {
      // A lost signal is one missing open in a habit count, never something
      // the user is looking at.
      jest.spyOn(planEndpoints, 'markPlanOpened').mockRejectedValue(new NetworkError('no signal') as never);
      await loaded();
      await fireEvent.press(screen.getByTestId('plan-accept'));
      await waitFor(() => expect(screen.queryByTestId('plan-accepted')).not.toBeNull());
      expect(screen.queryByTestId('plan-edit-error')).toBeNull();
    });
  });
});
