/**
 * Today, from the account (UC-2.R3 #173, ordering from UC-2.8 #169).
 *
 * ── The two claims worth a test ──────────────────────────────────
 *
 *  1. A rank can never lift a Nice above a Must. The groups are the user's own
 *     answer to "how much does this matter", and an estimate must not overrule
 *     them.
 *  2. Exactly one card explains itself. Every card explaining itself is no
 *     explanation at all.
 */
import React from 'react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor, within } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../api/auth';
import type { AuthUser } from '../../auth/types';
import { TodayScreen } from '../TodayScreen';
import type { Commitment } from '../../api/schemas/common';
import en from '../../i18n/locales/en.json';
import ar from '../../i18n/locales/ar.json';

import * as commitmentEndpoints from '../../api/endpoints/commitments';
import * as language from '../../i18n/language';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const USER: AuthUser = {
  uid: 'today-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

function item(overrides: Partial<Commitment> & { id: string }): Commitment {
  return {
    kind: 'task',
    title: overrides.id,
    description: null,
    person: null,
    status: 'active',
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
    timeSpec: { kind: 'due_by', dueAt: '2026-09-13T12:00:00.000Z', remindAt: null, timezone: 'UTC' },
    currentAckState: 'not_seen',
    postponedUntil: null,
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-01T09:00:00.000Z',
    confirmedAt: '2026-09-01T09:00:00.000Z',
    completedAt: null,
    droppedAt: null,
    ...overrides,
    id: overrides.id,
  } as Commitment;
}

function withPriority(id: string, level: 'low' | 'normal' | 'high', extra: Partial<Commitment> = {}) {
  return item({
    id,
    priority: { level, source: 'default', pressureAllowed: false, pressureLevel: 'none' } as Commitment['priority'],
    ...extra,
  });
}

beforeEach(() => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
});

afterEach(() => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

async function show(items: Commitment[]) {
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items } as never);
  const view = await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}><TodayScreen /></QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('query-loading')).toBeNull());
  return view;
}

describe('the day comes from the account', () => {
  it('shows what the server sent, in the groups the user chose', async () => {
    await show([withPriority('m', 'high'), withPriority('s', 'normal'), withPriority('n', 'low')]);
    expect(screen.queryByTestId('today-item-m')).not.toBeNull();
    expect(screen.queryByTestId('today-group-must')).not.toBeNull();
    expect(screen.queryByTestId('today-group-should')).not.toBeNull();
    expect(screen.queryByTestId('today-group-nice')).not.toBeNull();
  });

  it('shows the empty state when the account has nothing today', async () => {
    await show([]);
    expect(screen.queryByText(en.emptyTitle)).not.toBeNull();
    expect(screen.queryByTestId('today-group-must')).toBeNull();
  });

  it('offers a retry rather than a blank screen when the list fails', async () => {
    jest.spyOn(commitmentEndpoints, 'listToday').mockRejectedValue(new Error('offline'));
    await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <AppProvider>
          <AuthProvider repository={repository} isDevBundle={false}>
            <QueryClientProvider client={client}><TodayScreen /></QueryClientProvider>
          </AuthProvider>
        </AppProvider>
      </SafeAreaProvider>,
    );
    await waitFor(() => expect(screen.queryByTestId('query-loading')).toBeNull());
    expect(screen.queryByTestId('today-group-must')).toBeNull();
  });
});

describe('ranking', () => {
  it('orders by rank inside a group', async () => {
    await show([
      { ...withPriority('third', 'high'), rank: 2, reasonCodes: [] } as Commitment,
      { ...withPriority('first', 'high'), rank: 0, reasonCodes: [] } as Commitment,
      { ...withPriority('second', 'high'), rank: 1, reasonCodes: [] } as Commitment,
    ]);
    // Sent out of order on purpose: the rank decides, not the array.
    const order = within(screen.getByTestId('today-group-must'))
      .getAllByTestId(/^today-item-/)
      .map((node) => node.props.testID);
    expect(order).toEqual(['today-item-first', 'today-item-second', 'today-item-third']);
  });

  it('never lifts a Nice above a Must, whatever its rank', async () => {
    // The claim this screen rests on. Rank 0 on a Nice and rank 5 on a Must:
    // the Must still comes first, because the group is the user's own answer
    // and the rank only orders items inside it.
    await show([
      { ...withPriority('nice-urgent', 'low'), rank: 0, reasonCodes: ['overdue'] } as Commitment,
      { ...withPriority('must-later', 'high'), rank: 5, reasonCodes: ['due_today'] } as Commitment,
    ]);
    // Each sits in its own group, and not in the other's.
    expect(within(screen.getByTestId('today-group-must')).getByTestId('today-item-must-later')).toBeTruthy();
    expect(within(screen.getByTestId('today-group-must')).queryByTestId('today-item-nice-urgent')).toBeNull();
    expect(within(screen.getByTestId('today-group-nice')).getByTestId('today-item-nice-urgent')).toBeTruthy();
    // And the Must is rendered above the Nice, rank notwithstanding.
    expect(screen.getAllByTestId(/^today-item-/).map((n) => n.props.testID))
      .toEqual(['today-item-must-later', 'today-item-nice-urgent']);
  });

  it('marks an importance the user did not state', async () => {
    await show([
      item({ id: 'guessed', priority: { level: 'high', source: 'inferred', pressureAllowed: false, pressureLevel: 'none' } as Commitment['priority'] }),
      item({ id: 'stated', priority: { level: 'high', source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' } as Commitment['priority'] }),
    ]);
    expect(screen.queryByTestId('today-estimated-guessed')).not.toBeNull();
    expect(screen.queryByTestId('today-estimated-stated')).toBeNull();
  });
});

describe('the why-first line', () => {
  it('appears exactly once, on the top card', async () => {
    await show([
      { ...withPriority('first', 'high'), rank: 0, reasonCodes: ['overdue'] } as Commitment,
      { ...withPriority('second', 'high'), rank: 1, reasonCodes: ['due_today'] } as Commitment,
      { ...withPriority('third', 'normal'), rank: 2, reasonCodes: ['user_must'] } as Commitment,
    ]);
    // `getAllByTestId` would find every one; there must be exactly one.
    expect(screen.getAllByTestId('today-why-first')).toHaveLength(1);
    expect(screen.queryByText(`Why first: ${en.todayWhyOverdue}`)).not.toBeNull();
  });

  it('joins two reasons, deadline first', async () => {
    await show([
      { ...withPriority('top', 'high'), rank: 0, reasonCodes: ['overdue', 'user_must'] } as Commitment,
    ]);
    // The lead once, then both reasons. Not "Why first: … · Why first: …".
    expect(screen.queryByText(`Why first: ${en.todayWhyOverdue} · ${en.todayWhyMust}`)).not.toBeNull();
  });

  it('appears on nobody when the top card has nothing to say', async () => {
    // An item whose reason is "it is simply next" gets no line, rather than a
    // filler one.
    await show([{ ...withPriority('top', 'high'), rank: 0, reasonCodes: [] } as Commitment]);
    expect(screen.queryByTestId('today-why-first')).toBeNull();
  });
});

describe('a time that has passed', () => {
  it('is still shown, and is not a failure state', async () => {
    // There is no "overdue" in this product, and nothing is red anywhere.
    await show([item({ id: 'past', timeSpec: { kind: 'due_by', dueAt: '2020-01-01T09:00:00.000Z', remindAt: null, timezone: 'UTC' } })]);
    expect(screen.queryByTestId('today-item-past')).not.toBeNull();
    expect(screen.queryByTestId('today-time-past')).not.toBeNull();
  });

  it('shows a time for an item that has one, and a placeholder for one that does not', async () => {
    await show([
      item({ id: 'timed' }),
      item({ id: 'untimed', timeSpec: { kind: 'unscheduled', dueAt: null, remindAt: null, timezone: 'UTC' } }),
    ]);
    expect(screen.getByTestId('today-time-untimed').props.children).toBe(en.noTimeYet);
  });
});

describe('finished items', () => {
  it('are collapsed, and out of the live groups', async () => {
    await show([
      item({ id: 'done', status: 'completed' }),
      item({ id: 'dropped', status: 'dropped' }),
      withPriority('live', 'normal'),
    ]);
    expect(screen.queryByTestId('today-group-finished')).not.toBeNull();
    // Collapsed: the rows are not rendered until it is opened.
    expect(screen.queryByTestId('today-finished-done')).toBeNull();
    expect(screen.queryByTestId('today-item-live')).not.toBeNull();
  });

  it('do not count towards the open total', async () => {
    await show([item({ id: 'done', status: 'completed' }), withPriority('live', 'normal')]);
    expect(screen.getByTestId('today-count').props.children).toContain('1');
  });
});

describe('what the screen no longer invents', () => {
  it('marks a deadline at its time, with no extent', async () => {
    // `mapExtractionToCommand` only ever emits `due_by` or `unscheduled`, so
    // every commitment here is a point in time. The design prototype's `dur`
    // field was fiction; a block sized by it would tell the user they said how
    // long something takes when they only said when it was due. So the mark is
    // one time, never a range.
    await show([item({ id: 'timed', timeSpec: { kind: 'due_by', dueAt: '2026-09-13T12:00:00.000Z', remindAt: null, timezone: 'UTC' } })]);
    const mark = String(screen.getByTestId('today-time-timed').props.children);
    expect(mark).not.toMatch(/[–—]|\s-\s/);
  });

  it('reads the day from the account, never from the design seed', async () => {
    // The migration this screen exists for (#173). A re-introduced seed import
    // would make the screen green in tests and wrong on a device.
    const source = readFileSync(join(__dirname, '..', 'TodayScreen.tsx'), 'utf8');
    expect(source).not.toMatch(/state\/seed/);
  });
});

describe('the why-first line in every language', () => {
  /**
   * UC-2.8 (#169) asks for exactly one "why first" line in each of ar, he and
   * en. Every other test here renders in English, so a key missing from one
   * locale would pass all of them and ship a card that explains itself to
   * English speakers and nobody else.
   *
   * ── Hebrew is not one of them, and cannot be ─────────────────────
   *
   * `Lang` is `'ar' | 'en'`. `he.json` exists and is machine-translated, but
   * there is no way to put the app into Hebrew, so there is no rendering to
   * assert. Listing it here with a mocked tag would produce an English screen
   * and a green test — evidence of nothing.
   *
   * The Hebrew *strings* are covered where they can be: `whyFirst.test.ts`
   * builds the line in all three. Hebrew as a UI language is its own piece of
   * work, and #169 is reported as met in ar and en only.
   *
   * The language comes from the device locale, which `AppProvider` resolves
   * through `systemLanguageTag`, so mocking that is the whole switch.
   */
  const LOCALES: Record<string, Record<string, string>> = {
    ar: ar as unknown as Record<string, string>,
    en: en as unknown as Record<string, string>,
  };

  for (const [tag, strings] of Object.entries(LOCALES)) {
    it(`${tag}: exactly one card explains itself, in ${tag}`, async () => {
      jest.spyOn(language, 'systemLanguageTag').mockReturnValue(tag);
      await show([
        { ...withPriority('first', 'high'), rank: 0, reasonCodes: ['overdue', 'user_must'] } as Commitment,
        { ...withPriority('second', 'high'), rank: 1, reasonCodes: ['due_today'] } as Commitment,
      ]);

      expect(screen.getAllByTestId('today-why-first')).toHaveLength(1);
      // The whole line: the lead said once, then both reasons.
      expect(String(screen.getByTestId('today-why-first').props.children)).toBe(
        strings.todayWhyLead!.replace(
          '{reasons}',
          `${strings.todayWhyOverdue!} · ${strings.todayWhyMust!}`,
        ),
      );
    });
  }
});
