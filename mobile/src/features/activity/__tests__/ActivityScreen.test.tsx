/**
 * The activity screen (UC-3.15, #201).
 *
 * What is asserted here is what a review cannot see: that the calm week
 * renders one sentence instead of three zeroes, that a day boundary is a local
 * day and not a 24-hour bucket, that a second page is fetched and appended
 * rather than replacing the first, and that an entry this build has no words
 * for is skipped rather than printed as its own enum — which is exactly what
 * an older build will meet the day #194 or #200 lands.
 *
 * Every `render` is awaited: RNTL v14 returns a promise, and an un-awaited one
 * leaves the next case mounting nothing.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { ActivityScreen, dayHeading, groupByDay, planLine } from '../ActivityScreen';
import { dayKey } from '../../../i18n/format';
import * as timezone from '../../../i18n/timezone';
import { namedMoments } from '../moments';
import en from '../../../i18n/locales/en.json';
import ar from '../../../i18n/locales/ar.json';
import { strings } from '../../../i18n/strings';
import { isolateAuto } from '../../../i18n/bidi';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import listFixture from '../../../api/__fixtures__/activity.list.json';
import summaryFixture from '../../../api/__fixtures__/activity.summary.json';
import planAcceptedFixture from '../../../api/__fixtures__/activity.planAccepted.json';
import planProposalAcceptedFixture from '../../../api/__fixtures__/activity.planProposalAccepted.json';
import he from '../../../i18n/locales/he.json';
import { withHermesIntl } from '../../../testing/hermesIntl';
import { activityPageSchema, type ActivityItem, type ActivityPage, type WeeklySummary } from '../../../api/schemas/activity';

import * as activityEndpoints from '../../../api/endpoints/activity';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const USER: AuthUser = {
  uid: 'activity-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

const QUIET: WeeklySummary = {
  weekStart: '2026-09-13', completedCount: 0, plannedDaysCount: 0, keptCount: 0, moments: [],
};

function item(over: Partial<ActivityItem> & { id: string }): ActivityItem {
  return {
    kind: 'completed',
    at: '2026-09-14T09:00:00.000Z',
    commitmentId: 'c1',
    commitmentTitle: 'Call the clinic',
    ...over,
  };
}

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(() => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(activityEndpoints, 'getWeeklySummary').mockResolvedValue(QUIET as never);
  jest.spyOn(activityEndpoints, 'listActivity')
    .mockResolvedValue({ items: [], nextCursor: null } as ActivityPage as never);
});

afterEach(() => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

async function show() {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}><ActivityScreen onBack={() => {}} /></QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

describe('the week card', () => {
  it('says a quiet week is okay instead of printing three zeroes', async () => {
    await show();
    await waitFor(() => expect(screen.queryByTestId('activity-week-quiet')).not.toBeNull());

    expect(screen.getByTestId('activity-week-quiet').props.children).toBe(en.activityWeekQuiet);
    // The three count lines are not merely zero — they are not rendered.
    expect(screen.queryByTestId('activity-week-done')).toBeNull();
    expect(screen.queryByTestId('activity-week-planned')).toBeNull();
    expect(screen.queryByTestId('activity-week-kept')).toBeNull();
  });

  it('renders the three counts as positive sentences when the week had something in it', async () => {
    jest.spyOn(activityEndpoints, 'getWeeklySummary').mockResolvedValue({
      ...QUIET, completedCount: 4, plannedDaysCount: 2, keptCount: 3,
    } as never);
    await show();
    await waitFor(() => expect(screen.queryByTestId('activity-week-done')).not.toBeNull());

    const lines = ['activity-week-done', 'activity-week-planned', 'activity-week-kept']
      .map(id => String(screen.getByTestId(id).props.children));
    expect(lines.join(' ')).toContain('4');
    expect(lines.join(' ')).toContain('2');
    expect(lines.join(' ')).toContain('3');
    expect(screen.queryByTestId('activity-week-quiet')).toBeNull();
  });

  it('shows Moments with the date they were reached, and skips ones it has no words for', async () => {
    jest.spyOn(activityEndpoints, 'getWeeklySummary').mockResolvedValue({
      ...QUIET,
      moments: [
        { id: 'first_capture', reachedAt: '2026-09-01T09:00:00.000Z' },
        { id: 'done_10', reachedAt: '2026-09-10T09:00:00.000Z' },
        // A Moment a later backend adds. An older build must skip it.
        { id: 'done_250', reachedAt: '2026-09-12T09:00:00.000Z' },
      ],
    } as never);
    await show();
    await waitFor(() => expect(screen.queryByTestId('activity-moments')).not.toBeNull());

    expect(screen.queryByTestId('activity-moment-first_capture')).not.toBeNull();
    expect(screen.queryByTestId('activity-moment-done_10')).not.toBeNull();
    expect(screen.queryByTestId('activity-moment-done_250')).toBeNull();
  });

  it('survives a summary the server could not answer, and says nothing changed', async () => {
    jest.spyOn(activityEndpoints, 'getWeeklySummary').mockRejectedValue(new Error('down'));
    await show();
    await waitFor(() => expect(screen.queryByTestId('activity-unavailable')).not.toBeNull());
    expect(screen.getByTestId('activity-unavailable').props.children).toBe(en.activityUnavailable);
  });
});

describe('the history', () => {
  it('shows the calm empty copy for an account that has done nothing yet', async () => {
    await show();
    await waitFor(() => expect(screen.queryByTestId('activity-empty')).not.toBeNull());
    expect(screen.getByTestId('activity-empty').props.children).toBe(en.activityEmpty);
  });

  it('names a deleted commitment rather than leaving a blank line', async () => {
    jest.spyOn(activityEndpoints, 'listActivity').mockResolvedValue({
      items: [item({ id: 'a', commitmentTitle: null })], nextCursor: null,
    } as ActivityPage as never);
    await show();
    await waitFor(() => expect(screen.queryByText(en.activityRemovedItem)).not.toBeNull());
  });

  it('appends the next page rather than replacing the first', async () => {
    const listActivity = jest.spyOn(activityEndpoints, 'listActivity');
    listActivity.mockImplementation((async (input?: { cursor?: string | null }) => (
      input?.cursor
        ? { items: [item({ id: 'second', commitmentTitle: 'Second page' })], nextCursor: null }
        : { items: [item({ id: 'first', commitmentTitle: 'First page' })], nextCursor: 'c|1' }
    )) as never);

    await show();
    await waitFor(() => expect(screen.queryByText(isolateAuto('First page'))).not.toBeNull());

    /*
     * The list reaching its end. Fired as the event rather than by faking a
     * scroll geometry: jest has no layout, so a `scroll` with invented
     * measurements never gets past `VirtualizedList`'s own distance check and
     * would silently assert nothing.
     *
     * Awaited, because RNTL v14 events are async and an un-awaited one leaves
     * the assertions below reading the frame before the fetch.
     */
    await fireEvent(screen.getByTestId('activity-list'), 'endReached', { distanceFromEnd: 0 });

    await waitFor(() => expect(screen.queryByText(isolateAuto('Second page'))).not.toBeNull());
    expect(screen.queryByText(isolateAuto('First page'))).not.toBeNull();
    expect(listActivity).toHaveBeenCalledTimes(2);
  });

  it('walks past a page that held nothing to show rather than saying the history is empty', async () => {
    // The server keeps only allowlisted events, so a page of the log can come
    // back with no entries while the history continues below it. Saying
    // "nothing here yet" over that is the one thing the empty copy must not do.
    const listActivity = jest.spyOn(activityEndpoints, 'listActivity');
    listActivity.mockImplementation((async (input?: { cursor?: string | null }) => (
      input?.cursor
        ? { items: [item({ id: 'deeper', commitmentTitle: 'Further down the log' })], nextCursor: null }
        : { items: [], nextCursor: 'c|1' }
    )) as never);

    await show();
    await waitFor(() => expect(screen.queryByText(isolateAuto('Further down the log'))).not.toBeNull());
    expect(screen.queryByTestId('activity-empty')).toBeNull();
    expect(listActivity).toHaveBeenCalledTimes(2);
  });

  it('skips an entry whose kind this build has no words for', async () => {
    jest.spyOn(activityEndpoints, 'listActivity').mockResolvedValue({
      items: [
        item({ id: 'known', kind: 'completed', commitmentTitle: 'A known kind' }),
        // #201 names seven kinds. An eighth from a later backend must not put
        // its own enum on the screen, and must not break the page either.
        item({ id: 'unknown', kind: 'commitment_escalated', commitmentTitle: 'An unknown kind' }),
      ],
      nextCursor: null,
    } as ActivityPage as never);

    await show();
    await waitFor(() => expect(screen.queryByText(isolateAuto('A known kind'))).not.toBeNull());
    expect(screen.queryByText(isolateAuto('An unknown kind'))).toBeNull();
    expect(screen.queryByText('commitment_escalated')).toBeNull();
  });

  it('renders every kind that has a producer today, each with its own words', async () => {
    jest.spyOn(activityEndpoints, 'listActivity').mockResolvedValue({
      items: [
        item({ id: '1', kind: 'captured' }),
        item({ id: '2', kind: 'confirmed' }),
        item({ id: '3', kind: 'completed' }),
        item({ id: '4', kind: 'postponed', detail: { postponedUntil: '2026-09-15T09:00:00.000Z' } }),
        item({ id: '5', kind: 'dropped' }),
        item({ id: '6', kind: 'plan_accepted', commitmentId: null, commitmentTitle: null, detail: { planDate: '2026-09-14' } }),
        item({ id: '7', kind: 'plan_proposal_accepted', commitmentId: null, commitmentTitle: null, detail: { planDate: '2026-09-14' } }),
      ],
      nextCursor: null,
    } as ActivityPage as never);

    await show();
    await waitFor(() => expect(screen.queryByTestId('activity-item-completed')).not.toBeNull());
    for (const kind of ['captured', 'confirmed', 'completed', 'postponed', 'dropped', 'plan_accepted', 'plan_proposal_accepted']) {
      expect(screen.queryByTestId(`activity-item-${kind}`)).not.toBeNull();
    }
    // The dropped label is the design's own words, not a failure word.
    expect(screen.queryByText(en.activityKindDropped)).not.toBeNull();
  });
});

describe('an accepted plan (#194)', () => {
  const PLAN = item({
    id: 'plan', kind: 'plan_accepted', commitmentId: null, commitmentTitle: null, detail: { planDate: '2026-09-14' },
  });

  it('names the day the plan was for, and never reads as an item somebody removed', async () => {
    jest.spyOn(activityEndpoints, 'listActivity').mockResolvedValue({ items: [PLAN], nextCursor: null } as never);
    await show();
    await waitFor(() => expect(screen.queryByTestId('activity-item-plan_accepted')).not.toBeNull());

    // The entry is about a day, not a commitment, so its null title is not a
    // deletion. Saying "an item you removed" here would be a false statement
    // about something the person did.
    expect(screen.queryByText(en.activityRemovedItem)).toBeNull();
    expect(screen.queryByText(en.activityKindPlanAccepted)).not.toBeNull();
    expect(screen.getByTestId('activity-plan-date').props.children).toBe('Your plan for Monday, Sep 14');
  });

  it('says only that a plan was accepted when the entry carries no date', async () => {
    jest.spyOn(activityEndpoints, 'listActivity').mockResolvedValue({
      items: [{ ...PLAN, detail: undefined }], nextCursor: null,
    } as never);
    await show();
    await waitFor(() => expect(screen.queryByTestId('activity-item-plan_accepted')).not.toBeNull());
    expect(screen.queryByText(en.activityRemovedItem)).toBeNull();
    expect(screen.queryByTestId('activity-plan-date')).toBeNull();
  });

  /*
   * The plan date is a civil date — the day the plan was *for*, in the
   * account's zone — so it is printed as one, in the civil zone. Read as an
   * instant in the device zone it would slide to the 13th west of UTC. Run
   * under Hermes' Intl, because Node's is the one that hides device bugs.
   */
  const PLAN_LANGS: ['en' | 'ar' | 'he', string, string][] = [
    ['en', en.activityPlanFor, 'Monday'],
    ['ar', ar.activityPlanFor, 'الاثنين'],
    ['he', he.activityPlanFor, 'שני'],
  ];
  it.each(PLAN_LANGS)('prints the plan day in %s under Hermes Intl', (lang, template, weekday) => {
    const line = withHermesIntl(() => planLine('2026-09-14', lang, strings[lang]));
    expect(line).toContain(weekday);
    expect(line).toContain('14');
    expect(line).not.toMatch(/[{}]/);
    expect(line.startsWith(template.split('{date}')[0]!)).toBe(true);
    // Digits stay Latin, as everywhere else in the app.
    expect(/[٠-٩]/.test(line)).toBe(false);
  });

  it('renders the fixture the backend generated from a real acceptance, as the schema parses it', async () => {
    // Through the schema the client ships, not around it: a schema that did
    // not name `planDate` would strip it silently and the day would vanish.
    const parsed = activityPageSchema.parse(planAcceptedFixture);
    expect(parsed.items[0]!.detail?.planDate).toBe(planAcceptedFixture.items[0]!.detail.planDate);
    jest.spyOn(activityEndpoints, 'listActivity').mockResolvedValue(parsed as never);
    await show();
    await waitFor(() => expect(screen.queryByTestId('activity-item-plan_accepted')).not.toBeNull());
    expect(screen.queryByTestId('activity-plan-date')).not.toBeNull();
    expect(screen.queryByText(en.activityRemovedItem)).toBeNull();
  });
});

describe('grouping', () => {
  it('cuts the list on local days, so 23:30 and 00:30 are two days', () => {
    const sections = groupByDay([
      item({ id: 'a', at: '2026-09-14T20:30:00.000Z' }), // 23:30 local
      item({ id: 'b', at: '2026-09-14T21:30:00.000Z' }), // 00:30 local, next day
    ], 'Asia/Jerusalem');
    expect(sections.map(section => section.title)).toEqual(['2026-09-14', '2026-09-15']);
  });

  /*
   * The heading is the half of grouping a reader cannot check by eye.
   *
   * Every instant here is chosen, never read off the clock, and the two zones
   * are named — so this says the same thing on every machine and on every day,
   * which a "stamp it now and see" version would not (#382).
   */
  it('reads "today" from the user’s own day and not from the UTC day', () => {
    // 00:30 on the 15th in Asia/Jerusalem is still the 14th in UTC. Comparing
    // the local day key against the UTC clock — which is what omitting `now`
    // does — heads today's entries "Tomorrow" every night.
    const instant = new Date('2026-09-14T21:30:00.000Z');
    expect(dayKey(instant, 'Asia/Jerusalem')).toBe('2026-09-15');
    expect(dayKey(instant, 'UTC')).toBe('2026-09-14');

    const local = dayKey(instant, 'Asia/Jerusalem');
    expect(dayHeading(local, local, 'en')).toBe(en.today);
    expect(dayHeading(local, dayKey(instant, 'UTC'), 'en')).toBe(en.tomorrow);
    expect(dayHeading('2026-09-14', local, 'en')).toBe(en.yesterday);
    // Further back it is a date, not a word, and it is the section's own day.
    expect(dayHeading('2026-09-10', local, 'en')).toContain('10');
  });

  it('keeps the server order inside a day and never reorders it', () => {
    const sections = groupByDay([
      item({ id: 'a', at: '2026-09-14T12:00:00.000Z' }),
      item({ id: 'b', at: '2026-09-14T09:00:00.000Z' }),
      item({ id: 'c', at: '2026-09-14T11:00:00.000Z' }),
    ], 'UTC');
    expect(sections).toHaveLength(1);
    expect(sections[0]!.data.map(entry => entry.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('the day heading on screen', () => {
  it('heads today’s entries "today" in the half of the day UTC disagrees', async () => {
    // Both the zone and the clock are set by the test, so the assertion does
    // not depend on where or when it runs (#382).
    jest.spyOn(timezone, 'useTimeZone').mockReturnValue('Asia/Jerusalem');
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-14T21:30:00.000Z')); // 00:30 on the 15th
    try {
      jest.spyOn(activityEndpoints, 'listActivity').mockResolvedValue({
        items: [item({ id: 'a', at: '2026-09-14T21:10:00.000Z' })], nextCursor: null,
      } as ActivityPage as never);

      await show();
      await waitFor(() => expect(screen.queryByText(en.today)).not.toBeNull());
      expect(screen.queryByText(en.tomorrow)).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('the fixtures the backend generated', () => {
  it('are what the screen renders, so this is the real contract', async () => {
    jest.spyOn(activityEndpoints, 'listActivity').mockResolvedValue(listFixture as never);
    jest.spyOn(activityEndpoints, 'getWeeklySummary').mockResolvedValue(summaryFixture as never);

    await show();
    await waitFor(() => expect(screen.queryByTestId('activity-week-quiet')).not.toBeNull());
    expect(screen.queryByTestId('activity-moments')).not.toBeNull();
    // More than one entry is about the same commitment — captured, confirmed
    // and completed all name it — so this asserts presence, not a count.
    expect(screen.queryAllByText(isolateAuto('Call the dentist')).length).toBeGreaterThan(0);
  });

  it('carries Moments even though the fixture week is empty', () => {
    // The acceptance criterion, read off the generated fixture: the counter
    // answered although nothing happened in the week being summarised.
    expect(summaryFixture.completedCount).toBe(0);
    expect(namedMoments(summaryFixture.moments, strings.en).length).toBeGreaterThan(0);
  });
});

describe('an accepted change to a plan (#587)', () => {
  it('says a change was accepted, for which day, and never "an item you removed"', async () => {
    // Through the schema, from the fixture the backend recorded after a real
    // `accept_proposal`: the ledger's decision entry, read back through the
    // activity route.
    const parsed = activityPageSchema.parse(planProposalAcceptedFixture);
    expect(parsed.items.map(entry => entry.kind)).toEqual(['plan_proposal_accepted']);
    // The fixture is a page of one with a live cursor; answering the next page
    // with it again would render the entry twice, so the history ends here.
    jest.spyOn(activityEndpoints, 'listActivity').mockResolvedValue({ ...parsed, nextCursor: null } as never);
    await show();
    await waitFor(() => expect(screen.queryByTestId('activity-item-plan_proposal_accepted')).not.toBeNull());

    expect(screen.queryByText(en.activityKindPlanChangeAccepted)).not.toBeNull();
    // Not the whole-day label: accepting a change is not accepting the day.
    expect(screen.queryByText(en.activityKindPlanAccepted)).toBeNull();
    expect(screen.getByTestId('activity-plan-date').props.children).toBe('Your plan for Sunday, Aug 9');
    expect(screen.queryByText(en.activityRemovedItem)).toBeNull();
  });

  it('says it in Arabic when the account is in Arabic', async () => {
    const parsed = activityPageSchema.parse(planProposalAcceptedFixture);
    jest.spyOn(activityEndpoints, 'listActivity').mockResolvedValue({ ...parsed, nextCursor: null } as never);
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
    try {
      await show();
      await waitFor(() => expect(screen.queryByText(ar.activityKindPlanChangeAccepted)).not.toBeNull());
      expect(screen.queryByText(ar.activityKindPlanAccepted)).toBeNull();
      expect(screen.queryByText(ar.activityRemovedItem)).toBeNull();
    } finally {
      await AsyncStorage.removeItem(LANGUAGE_STORAGE_KEY);
    }
  });
});

describe('every language', () => {
  it.each(['en', 'ar', 'he'] as const)('has a name for every Moment the contract lists, in %s', lang => {
    const moments = ['first_capture', 'first_done', 'first_plan_accepted', 'done_10', 'done_25', 'done_50', 'done_100']
      .map(id => ({ id, reachedAt: '2026-09-14T09:00:00.000Z' }));
    expect(namedMoments(moments, strings[lang])).toHaveLength(7);
  });

  it('renders Arabic, not an English fallback, when the account is in Arabic', async () => {
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
    await show();
    // The stored preference is read in an effect, so the first frame is the
    // device language; wait for the one the user actually chose.
    await waitFor(() => expect(screen.queryByText(ar.activityEmpty)).not.toBeNull());
    expect(screen.queryByText(en.activityEmpty)).toBeNull();
    expect(screen.queryByText(ar.activityWeekQuiet)).not.toBeNull();
  });
});
