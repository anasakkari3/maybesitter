/**
 * "Considering / Waiting", on the phone (#519).
 *
 * What the screen must hold, each a case below:
 * - it says "this is not a commitment yet", unconditionally;
 * - it shows the person's own sentence, and no importance and no time — there
 *   is no Must / Should / Nice anywhere on a seed;
 * - the four actions each call the route they claim to, and nothing else;
 * - a failed action says so and leaves the seed where it was;
 * - promoted and dismissed seeds drop off the list, and the empty state is
 *   what is left.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import * as language from '../../../i18n/language';
import en from '../../../i18n/locales/en.json';
import ar from '../../../i18n/locales/ar.json';
import he from '../../../i18n/locales/he.json';
import * as seedEndpoints from '../../../api/endpoints/seeds';
import type { Seed } from '../../../api/schemas/seeds';
import { SeedsScreen } from '../SeedsScreen';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = {
  uid: 'seed-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};
const MAYBE = "Maybe I'll apply to NVIDIA this semester.";

function seed(overrides: Partial<Seed> = {}): Seed {
  return {
    version: 'intent-seed-v1',
    seedId: 'seed-1',
    scopeId: USER.uid,
    kind: 'consideration',
    summary: MAYBE,
    status: 'open',
    revisitAt: null,
    source: 'capture',
    sourceRef: 'proposal-1',
    provenance: { proposalId: 'proposal-1', extractor: 'rule-based', confirmedByUserAt: '2026-09-20T09:00:00.000Z' },
    promotedTo: null,
    createdAt: '2026-09-20T09:00:00.000Z',
    updatedAt: '2026-09-20T09:00:00.000Z',
    ...overrides,
  };
}

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(async () => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(language, 'systemLanguageTag').mockReturnValue('en-US');
  await AsyncStorage.removeItem(LANGUAGE_STORAGE_KEY);
  jest.spyOn(seedEndpoints, 'listSeeds').mockResolvedValue({ items: [seed()] } as never);
  jest.spyOn(seedEndpoints, 'patchSeed').mockResolvedValue({ success: true, seed: seed({ status: 'snoozed' }) } as never);
  jest.spyOn(seedEndpoints, 'promoteSeed').mockResolvedValue(
    { success: true, replayed: false, seed: seed({ status: 'promoted', promotedTo: { kind: 'commitment', id: 'c1' } }) } as never,
  );
});

afterEach(async () => {
  cleanup();
  await new Promise(resolve => setTimeout(resolve, 0));
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

async function show(lang: 'en' | 'ar' | 'he' = 'en') {
  if (lang !== 'en') await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}>
            <SeedsScreen onBack={() => {}} />
          </QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

function text(testID: string): string {
  return screen.getByTestId(testID).props.children as string;
}

describe('the Considering / Waiting screen', () => {
  it('says this is not a commitment yet, and shows the sentence as written', async () => {
    await show();
    await waitFor(() => expect(screen.queryByTestId('seed-summary-seed-1')).not.toBeNull());

    expect(text('seeds-not-commitment')).toBe(en.seedsNotCommitment);
    // Verbatim: not a paraphrase, not a title derived from it.
    expect(text('seed-summary-seed-1')).toBe(MAYBE);
    expect(text('seed-kind-seed-1')).toBe(en.seedKindConsideration);
  });

  it.each(['ar', 'he'] as const)('says it in %s too', async (lang) => {
    const bundle = lang === 'ar' ? ar : he;
    await show(lang);
    await waitFor(() => expect(screen.queryByTestId('seeds-not-commitment')).not.toBeNull());
    expect(text('seeds-not-commitment')).toBe(bundle.seedsNotCommitment);
  });

  it('carries no importance and no time anywhere on a seed', async () => {
    await show();
    await waitFor(() => expect(screen.queryByTestId('seed-summary-seed-1')).not.toBeNull());

    // Must / Should / Nice is the classification the issue forbids on a seed,
    // and a rendered time would be the product scheduling a maybe.
    const rendered = JSON.stringify(screen.toJSON());
    for (const forbidden of [en.mustL, en.shouldL, en.niceL]) {
      expect(rendered).not.toContain(forbidden);
    }
    expect(screen.queryByTestId('seed-revisit-seed-1')).toBeNull();
  });

  it('turns a seed into a task through the promote route, and nothing else', async () => {
    await show();
    await waitFor(() => expect(screen.queryByTestId('seed-to-task-seed-1')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('seed-to-task-seed-1'));

    await waitFor(() => expect(seedEndpoints.promoteSeed).toHaveBeenCalledWith('seed-1', 'commitment'));
    expect(seedEndpoints.patchSeed).not.toHaveBeenCalled();
  });

  it('turns a seed into a goal through the same route with the other target', async () => {
    await show();
    await waitFor(() => expect(screen.queryByTestId('seed-to-goal-seed-1')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('seed-to-goal-seed-1'));

    await waitFor(() => expect(seedEndpoints.promoteSeed).toHaveBeenCalledWith('seed-1', 'goal'));
  });

  it('"Later" and "Dismiss" are patches, never promotions', async () => {
    await show();
    await waitFor(() => expect(screen.queryByTestId('seed-later-seed-1')).not.toBeNull());

    await fireEvent.press(screen.getByTestId('seed-later-seed-1'));
    await waitFor(() => expect(seedEndpoints.patchSeed).toHaveBeenCalledWith('seed-1', { status: 'snoozed' }));

    await fireEvent.press(screen.getByTestId('seed-dismiss-seed-1'));
    await waitFor(() => expect(seedEndpoints.patchSeed).toHaveBeenCalledWith('seed-1', { status: 'dismissed' }));
    expect(seedEndpoints.promoteSeed).not.toHaveBeenCalled();
  });

  it('a failed action says so and leaves the seed on the screen', async () => {
    jest.spyOn(seedEndpoints, 'promoteSeed').mockRejectedValue(new Error('nope') as never);
    await show();
    await waitFor(() => expect(screen.queryByTestId('seed-to-task-seed-1')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('seed-to-task-seed-1'));

    await waitFor(() => expect(screen.queryByTestId('seed-failed-seed-1')).not.toBeNull());
    expect(text('seed-failed-seed-1')).toBe(en.errorsGeneric);
    expect(screen.queryByTestId('seed-summary-seed-1')).not.toBeNull();
  });

  it('shows the revisit date the person set, and calls it a bring-back rather than a due time', async () => {
    jest.spyOn(seedEndpoints, 'listSeeds').mockResolvedValue(
      { items: [seed({ status: 'snoozed', revisitAt: '2026-10-05T09:00:00.000Z' })] } as never,
    );
    await show();
    await waitFor(() => expect(screen.queryByTestId('seed-revisit-seed-1')).not.toBeNull());

    // The copy is the product's promise: «Bring it back on …», never "due".
    expect(en.seedRevisitOn).toContain('{date}');
    expect(en.seedRevisitOn.toLowerCase()).not.toContain('due');
    // And the row says "Later", not a Must/Should/Nice or a deadline.
    expect(JSON.stringify(screen.toJSON())).toContain(en.seedStatusSnoozed);
  });

  it('a promoted or dismissed seed is off the list, and the empty state is what is left', async () => {
    jest.spyOn(seedEndpoints, 'listSeeds').mockResolvedValue({
      items: [
        seed({ seedId: 'p', status: 'promoted', promotedTo: { kind: 'goal', id: 'g1' } }),
        seed({ seedId: 'd', status: 'dismissed' }),
      ],
    } as never);
    await show();

    await waitFor(() => expect(screen.queryByTestId('seeds-empty')).not.toBeNull());
    expect(screen.queryByTestId('seed-p')).toBeNull();
    expect(screen.queryByTestId('seed-d')).toBeNull();
  });
});
