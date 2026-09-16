import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider, useApp } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { TodayPlanCard } from '../TodayPlanCard';
import { NetworkError } from '../../../api/errors';
import type { DailyPlan } from '../../../api/schemas/plan';
import { deviceTimeZone } from '../../../i18n/timezone';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import { deferred } from '../../../testing/deferred';
import { Txt } from '../../../ui/primitives';
import en from '../../../i18n/locales/en.json';
import ar from '../../../i18n/locales/ar.json';
import he from '../../../i18n/locales/he.json';
import todayFixture from '../../../api/__fixtures__/plan.today.json';

import * as planEndpoints from '../../../api/endpoints/plans';

/**
 * The way into today's plan from Today (UC-3.10b, #195 step 4).
 *
 * Every `render` and every `fireEvent` is awaited: RNTL v14 returns promises,
 * and an un-awaited one leaves the next case mounting nothing and passing
 * while asserting about an empty tree.
 *
 * ── Why the state is read from inside the tree ───────────────────
 *
 * `openPlan` is a state change, and the component it changes is the one being
 * rendered. A test that captured it into an outer variable from a render prop
 * would be writing to that variable during React's render phase — the thing
 * RNTL v14 made unsafe. `Probe` renders the state as text instead, which is
 * also closer to what the screen switch in `Root.tsx` actually reads.
 */

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const USER: AuthUser = {
  uid: 'today-plan-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

const BASE = todayFixture.plan as DailyPlan;

function planWith(over: Partial<DailyPlan> = {}): DailyPlan {
  return { ...BASE, ...over };
}

/**
 * The day the card is about, worked out without the app's own helper.
 *
 * Derived from the clock this suite is actually running on, never written down
 * as an instant: a literal date here would be right on the afternoon it was
 * typed and wrong for every run afterwards.
 */
function deviceDay(): string {
  const zone = deviceTimeZone();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const part = (type: string) => parts.find(entry => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** The app state the card changes, rendered where a test can read it. */
function Probe() {
  const { s } = useApp();
  return <Txt testID="probe">{`${s.screen}:${s.planDate ?? '-'}`}</Txt>;
}

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(async () => {
  onlineManager.setOnline(true);
  await AsyncStorage.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(planEndpoints, 'getPlan').mockResolvedValue(planWith() as never);
});

afterEach(() => {
  client.clear();
  onlineManager.setOnline(true);
  resetAuthForTests();
  jest.restoreAllMocks();
});

async function show() {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}>
            <TodayPlanCard />
            <Probe />
          </QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

async function shown() {
  await show();
  await waitFor(() => expect(screen.queryByTestId('today-plan-card')).not.toBeNull());
}

/**
 * Waits until the plan query has actually answered.
 *
 * `expect(getPlan).toHaveBeenCalled()` is not this: the call happens on the
 * first render, so a `waitFor` on it resolves before the answer arrives and
 * before React has re-rendered with it — which makes "renders nothing" pass on
 * a component that was simply not finished yet. A mutant that deleted the
 * "dismissed stays dismissed" rule survived exactly that assertion.
 *
 * The signed-out key is skipped. The first render happens before the auth
 * repository has answered, and `usePlan` is disabled for `signed-out`, so that
 * query sits at `pending/idle` for the whole test and never settles.
 */
async function planAnswered() {
  await waitFor(() => {
    const queries = client.getQueryCache().findAll({
      predicate: query => query.queryKey.includes('plan') && !query.queryKey.includes('signed-out'),
    });
    expect(queries.length).toBeGreaterThan(0);
    for (const query of queries) {
      const key = query.queryKey.join('/');
      expect({ key, state: `${query.state.status}/${query.state.fetchStatus}` })
        .toEqual({ key, state: expect.stringMatching(/^(success|error)\/idle$/) });
    }
  });
}

describe('the card appears only when there is something to appear about', () => {
  it('asks for the plan for the day the device is in', async () => {
    await shown();
    expect(planEndpoints.getPlan).toHaveBeenCalledWith(deviceDay());
  });

  it('renders nothing at all while it is still asking', async () => {
    // Today's own list is the screen. A skeleton above it would make the
    // plan's latency into the day's.
    //
    // "Still asking" is held open rather than caught in flight, so the two
    // assertions below cannot be beaten by a machine that answered faster than
    // this line — see `src/testing/deferred.ts`.
    //
    // It is settled at the end rather than left hanging: a promise that never
    // resolves keeps Jest's worker alive after the run, which turns one held
    // state into a suite that does not exit.
    const answer = deferred<DailyPlan>();
    jest.spyOn(planEndpoints, 'getPlan').mockReturnValue(answer.promise as never);
    await show();
    expect(screen.queryByTestId('today-plan-card')).toBeNull();
    expect(screen.queryByTestId('query-loading')).toBeNull();

    await act(async () => { answer.resolve(planWith()); });
    await waitFor(() => expect(screen.queryByTestId('today-plan-card')).not.toBeNull());
  });

  it('renders nothing when there is no plan for today', async () => {
    jest.spyOn(planEndpoints, 'getPlan').mockResolvedValue(null as never);
    await show();
    await planAnswered();
    expect(screen.queryByTestId('today-plan-card')).toBeNull();
  });

  it('says nothing rather than apologising when the plan could not be fetched', async () => {
    // No error, no Retry: somebody with no signal came here to read their day,
    // and a failure banner about a second feature is not their problem.
    jest.spyOn(planEndpoints, 'getPlan').mockRejectedValue(new NetworkError('no signal') as never);
    await show();
    await planAnswered();
    expect(screen.queryByTestId('today-plan-card')).toBeNull();
    expect(screen.queryByTestId('query-error')).toBeNull();
    expect(screen.queryByText(en.errorsNetwork)).toBeNull();
  });

  it('does not come back after somebody has said “not today”', async () => {
    // "Not today" is an answer. Putting the card back at the top of Today
    // would be this app asking a second time.
    jest.spyOn(planEndpoints, 'getPlan').mockResolvedValue(planWith({ status: 'dismissed' }) as never);
    await show();
    await planAnswered();
    // The plan is there and it answered; the card is the thing that is not.
    expect(screen.queryByTestId('today-plan-summary')).toBeNull();
    expect(screen.queryByTestId('today-plan-card')).toBeNull();
  });

  it('stays after somebody has accepted, and says so', async () => {
    // An accepted plan is still the day's plan, and still worth reaching.
    jest.spyOn(planEndpoints, 'getPlan').mockResolvedValue(planWith({ status: 'accepted' }) as never);
    await shown();
    expect(screen.getByTestId('today-plan-summary').props.children).toBe(en.planAcceptedStatus);
  });
});

describe('what the card says', () => {
  it('counts what the planner placed, without naming any of it', async () => {
    await shown();
    const summary = String(screen.getByTestId('today-plan-summary').props.children);
    expect(summary).toContain('3');
    for (const item of BASE.scheduled) expect(summary).not.toContain(item.title);
    expect(summary).not.toContain(BASE.explanation.text);
  });

  it('is a sentence on a day the planner placed nothing', async () => {
    jest.spyOn(planEndpoints, 'getPlan').mockResolvedValue(planWith({ scheduled: [] }) as never);
    await shown();
    const summary = String(screen.getByTestId('today-plan-summary').props.children);
    expect(summary.length).toBeGreaterThan(0);
    // The ICU source itself reaching a screen is the #195 Hermes defect; the
    // sweep in `i18n/__tests__/hermesPlurals.test.ts` holds the device engine.
    expect(summary).not.toMatch(/plural|[{}]/);
  });

  it('opens that day’s plan, and only on a press', async () => {
    await shown();
    expect(screen.getByTestId('probe').props.children).toBe('today:-');
    await fireEvent.press(screen.getByTestId('today-plan-open'));
    await waitFor(() =>
      expect(screen.getByTestId('probe').props.children).toBe(`plan:${deviceDay()}`));
  });
});

describe('in the two languages this product defaults to', () => {
  /**
   * Arabic-Indic digits folded to Latin before a count is looked for.
   *
   * `INTL_LOCALE` sets `ar-u-nu-latn` today, so «٣» should never appear — but
   * this assertion is about *a count being shown*, and it must not start
   * passing or failing because somebody changed a numbering system. NFKC does
   * not fold these: `'٣'.normalize('NFKC')` is still `'٣'`. The Latin-digit
   * decision itself is owned by `i18n/__tests__/locale.test.ts`.
   */
  function foldDigits(text: string): string {
    return text.replace(/[٠-٩۰-۹]/g, digit =>
      String((digit.codePointAt(0)! - (digit >= '۰' ? 0x06F0 : 0x0660))));
  }

  /** Not `as const`: `it.each` needs a mutable tuple to spread into the case. */
  const BUNDLES: ['ar' | 'he', { planTitle: string }][] = [['ar', ar], ['he', he]];

  it.each(BUNDLES)('renders the count in %s, formatted, with nothing accusing anybody', async (lang, bundle) => {
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
    await show();
    // The stored preference is read in an effect, so the first frame is the
    // device language; wait for the one the user actually chose.
    await waitFor(() => expect(screen.queryByText(bundle.planTitle)).not.toBeNull());

    const summary = foldDigits(String(screen.getByTestId('today-plan-summary').props.children));
    expect(summary).toContain('3');
    expect(summary).not.toMatch(/plural|[{}]/);
    expect(screen.queryByText(en.planTitle)).toBeNull();

    // The same accusations `planCopy.test.ts` polices the bundles for, asserted
    // here against what was actually put on screen. `\b` cannot see either
    // script, so each boundary is "not another letter of this script".
    const AR = '؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿';
    const HE = '֐-׿יִ-ﭏ';
    const rendered = JSON.stringify(screen.toJSON());
    for (const pattern of [
      /فشل|فاشل/, /متأخّ?ر/, new RegExp(`(?<![${AR}])فات(?:ك|ه|ت|وا)?(?![${AR}])`, 'u'),
      /ما لحق/, /كان لازم|كان المفروض|مقصّر/,
      /נכשל|כישלון/, /פספס|החמצ/, new RegExp(`(?<![${HE}])מאחר(?![${HE}])`, 'u'), /באיחור|פיגור/,
      /\bfail(ed|ure|s)?\b/i, /\bmiss(ed|ing)?\b/i, /\bbehind\b/i, /\boverdue\b/i,
    ]) {
      expect({ pattern: pattern.source, present: pattern.test(rendered) })
        .toEqual({ pattern: pattern.source, present: false });
    }
  });
});
