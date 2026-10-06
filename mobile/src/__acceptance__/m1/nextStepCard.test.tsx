import React from 'react';
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../api/auth';
import { LANGUAGE_STORAGE_KEY } from '../../i18n/language';
import type { AuthUser } from '../../auth/types';
import type { Commitment } from '../../api/schemas/common';
import type { CommitmentView } from '../../features/commitments/model';
import { NextStepCard } from '../../features/nextStep/NextStepCard';
import { TodayScreen } from '../../screens/TodayScreen';
import * as nextStepEndpoints from '../../api/endpoints/nextStep';
import * as commitmentEndpoints from '../../api/endpoints/commitments';
import * as consentEndpoints from '../../api/endpoints/consents';
import * as planEndpoints from '../../api/endpoints/plans';
import consentsFixture from '../../api/__fixtures__/consents.answered.json';
import ar from '../../i18n/locales/ar.json';

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const useWindowDimensions = require('react-native/Libraries/Utilities/useWindowDimensions')
  .default as jest.Mock;

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = {
  uid: 'm1-next-step-user', email: 'm1@example.com', emailVerified: true, displayName: null, providerIds: ['password'],
};

// These are deliberately hard-coded from ar.json at 62699810. The keys may be
// removed or repurposed by the implementation; the struck words must not survive.
const OLD_NEXT_STEP_LABEL = '\u062e\u0637\u0648\u062a\u0643 \u0627\u0644\u062a\u0627\u0644\u064a\u0629';
const OLD_PROPOSAL_NOTE = '\u0647\u0630\u0627 \u0627\u0642\u062a\u0631\u0627\u062d. \u0644\u0645 \u064a\u062a\u063a\u064a\u0651\u0631 \u0623\u064a \u0634\u064a\u0621 \u0628\u0639\u062f.';
const OLD_EVIDENCE = ['\u0644\u0627\u0632\u0645 \u062e\u0644\u0627\u0644 \u064a\u0648\u0645', '\u0628\u0631\u0651\u0627 \u0623\u0648\u0642\u0627\u062a\u0643 \u0627\u0644\u0645\u0639\u062a\u0627\u062f\u0629', '\u0641\u064a \u0648\u0642\u062a \u0642\u0628\u0644 \u0645\u0627 \u062a\u0633\u062a\u062d\u0642'] as const;
const ESTIMATED_IMPORTANCE = '\u0627\u0644\u0623\u0647\u0645\u064a\u0629 \u0645\u0642\u0631\u0648\u0621\u0629 \u0645\u0646 \u0643\u0644\u0627\u0645\u0643';

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

function recommendation() {
  return {
    version: 'v1',
    proposalId: 'm1-proposal',
    state: 'ready',
    locale: 'ar',
    primaryStep: { commitmentId: 'c-1', title: '\u0627\u0628\u0639\u062b \u0627\u0644\u062a\u0642\u0631\u064a\u0631 \u0644\u0633\u0627\u0645\u064a' },
    explanation: {
      summary: 'server words are never shown',
      evidenceLabels: ['server labels are never shown'],
      evidenceCodes: [
        { code: 'due_within_24h' },
        { code: 'outside_usual_hours' },
        { code: 'fits_before_due' },
      ],
      sensitiveInferenceUsed: false,
    },
    availableActions: ['accept', 'defer', 'dismiss'],
    persistence: { occurred: false, confirmationRequired: true },
  };
}

function response(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    participantId: USER.uid,
    recommendation: recommendation(),
    ...overrides,
  };
}

const lookup = new Map<string, CommitmentView>([['c-1', {
  id: 'c-1', title: '\u0627\u0628\u0639\u062b \u0627\u0644\u062a\u0642\u0631\u064a\u0631 \u0644\u0633\u0627\u0645\u064a', importance: 'must', status: 'active',
  shownAt: '2026-10-06T10:00:00.000Z', allDay: false, isPast: false,
  importanceIsStated: false, rank: 0, reasonCodes: [],
}]]);

function todayItem(): Commitment {
  return {
    id: 'c-1', kind: 'task', title: '\u0627\u0628\u0639\u062b \u0627\u0644\u062a\u0642\u0631\u064a\u0631 \u0644\u0633\u0627\u0645\u064a', description: null, person: null, status: 'active',
    priority: { level: 'high', source: 'explicit', pressureAllowed: false, pressureLevel: 'none' },
    timeSpec: { kind: 'due_by', dueAt: '2026-10-06T12:00:00.000Z', endAt: null, remindAt: null, allDay: false, timezone: 'UTC' },
    currentAckState: 'not_seen', postponedUntil: null,
    createdAt: '2026-10-01T09:00:00.000Z', updatedAt: '2026-10-01T09:00:00.000Z', confirmedAt: '2026-10-01T09:00:00.000Z',
    completedAt: null, droppedAt: null,
  } as Commitment;
}

function providers(child: React.ReactNode) {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}>{child}</QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>
  );
}

async function showProposal(fontScale = 1) {
  useWindowDimensions.mockReturnValue({ width: 390, height: 844, scale: 3, fontScale });
  jest.spyOn(nextStepEndpoints, 'getNextStep').mockResolvedValue(response() as never);
  const view = await render(providers(<NextStepCard lookup={lookup} />));
  await waitFor(() => expect(screen.queryByTestId('next-step-card')).not.toBeNull());
  return view;
}

async function showToday(nextStep: unknown) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  jest.spyOn(nextStepEndpoints, 'getNextStep').mockResolvedValue(nextStep as never);
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [todayItem()] } as never);
  jest.spyOn(planEndpoints, 'getPlan').mockResolvedValue(null as never);
  jest.spyOn(consentEndpoints, 'getConsents').mockResolvedValue(consentsFixture as never);
  const view = await render(providers(<TodayScreen />));
  await waitFor(() => expect(screen.queryByTestId('query-loading')).toBeNull());
  return view;
}

beforeEach(async () => {
  onlineManager.setOnline(true);
  useWindowDimensions.mockReset();
  useWindowDimensions.mockReturnValue({ width: 390, height: 844, scale: 3, fontScale: 1 });
  await AsyncStorage.clear();
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
});

afterEach(async () => {
  await cleanup();
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});

it('A3 today next-step card: struck evidence chips and the old proposal footer leave the face while reasons stay in the expander', async () => {
  await showProposal();
  const card = within(screen.getByTestId('next-step-card'));

  for (const old of OLD_EVIDENCE) expect(card.queryByText(old)).toBeNull();
  expect(card.queryByText(OLD_PROPOSAL_NOTE)).toBeNull();
  expect(card.queryByTestId('next-step-note')).toBeNull();
  expect(card.queryByText(OLD_NEXT_STEP_LABEL)).toBeNull();

  expect(card.queryByTestId('next-step-why')).toBeNull();
  await act(async () => { await fireEvent.press(card.getByTestId('next-step-why-toggle')); });
  const reasons = within(card.getByTestId('next-step-why'));
  for (const old of OLD_EVIDENCE) expect(reasons.getByText(`· ${old}`)).toBeTruthy();
});

it('A3 today next-step card: estimated importance remains visible at an accessibility text size independently of evidence chips', async () => {
  await showProposal(1.64);
  const card = within(screen.getByTestId('next-step-card'));

  expect(card.getByText(ESTIMATED_IMPORTANCE)).toBeTruthy();
  expect(card.queryByTestId('next-step-evidence')).toBeNull();
  for (const old of OLD_EVIDENCE) expect(card.queryByText(old)).toBeNull();
});

it('A3 today next-step card: only proposals replace the old next-step badge; fallback and quiet cards keep it', async () => {
  const proposal = await showProposal();
  const proposalCard = within(screen.getByTestId('next-step-card'));
  const suggestedLabel = (ar as unknown as Record<string, string>).nextStepSuggestedLabel;
  expect(typeof suggestedLabel === 'string' && suggestedLabel.trim().length > 0).toBe(true);
  expect(proposalCard.getByText(suggestedLabel ?? '')).toBeTruthy();
  expect(proposalCard.queryByText(OLD_NEXT_STEP_LABEL)).toBeNull();
  await proposal.unmount();

  const empty = response({
    recommendation: { version: 'v1', proposalId: 'empty', state: 'empty', locale: 'ar', primaryStep: null, explanation: null, availableActions: [] },
  });
  const fallback = await showToday(empty);
  await waitFor(() => expect(screen.queryByTestId('today-primary')).not.toBeNull());
  expect(within(screen.getByTestId('today-primary')).getByText(OLD_NEXT_STEP_LABEL)).toBeTruthy();
  await fallback.unmount();

  await showToday({ ...empty, exposure: { allowed: false, reason: 'quiet_mode' } });
  await waitFor(() => expect(screen.queryByTestId('today-quiet')).not.toBeNull());
  expect(within(screen.getByTestId('today-quiet')).getByText(OLD_NEXT_STEP_LABEL)).toBeTruthy();
});
