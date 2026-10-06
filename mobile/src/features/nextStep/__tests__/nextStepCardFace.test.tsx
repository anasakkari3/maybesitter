/**
 * What the next-step card face carries since the owner's audit of 2026-10-06
 * (image 1): no reasoning chips and no footer, facts about the item still on
 * it, and the estimated-importance tag at every text size (it used to vanish
 * from the larger sizes up).
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { NextStepCard } from '../NextStepCard';
import en from '../../../i18n/locales/en.json';
import * as nextStepEndpoints from '../../../api/endpoints/nextStep';
import type { CommitmentView } from '../../commitments/model';

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({ __esModule: true, default: jest.fn() }));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const useWindowDimensions = require('react-native/Libraries/Utilities/useWindowDimensions').default as jest.Mock;

const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const USER: AuthUser = { uid: 'ns-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'] };
const ITEM: CommitmentView = {
  id: 'c-1', title: 'Send the report', importance: 'should', status: 'active',
  shownAt: '2026-10-06T07:00:00.000Z', allDay: false, isPast: true,
  importanceIsStated: false, rank: undefined, reasonCodes: [],
};

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(() => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
});
afterEach(() => { client.clear(); resetAuthForTests(); jest.restoreAllMocks(); useWindowDimensions.mockReset(); });

async function show(fontScale: number) {
  useWindowDimensions.mockReturnValue({ width: 390, height: 844, scale: 3, fontScale });
  jest.spyOn(nextStepEndpoints, 'getNextStep').mockResolvedValue({
    success: true,
    participantId: USER.uid,
    recommendation: {
      version: 'v1', proposalId: 'p-1', state: 'ready', locale: 'en',
      primaryStep: { commitmentId: 'c-1', title: 'Send the report' },
      explanation: {
        summary: 'x', evidenceLabels: ['x'], sensitiveInferenceUsed: false,
        evidenceCodes: [{ code: 'overdue' }, { code: 'due_within_24h' }, { code: 'outside_usual_hours' }, { code: 'fits_before_due' }],
      },
      availableActions: ['accept', 'defer', 'done'],
      persistence: { occurred: false, confirmationRequired: true },
    },
  } as never);
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}><NextStepCard lookup={new Map([['c-1', ITEM]])} /></QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('next-step-open')).not.toBeNull());
}

describe('the next-step card face', () => {
  it('drops the reasoning chips the owner struck, and the footer', async () => {
    await show(1);
    for (const struck of [en.evidenceDueWithin24h, en.evidenceOutsideUsualHours, en.evidenceFitsBeforeDue]) {
      expect(screen.queryByText(struck)).toBeNull();
    }
    expect(screen.queryByTestId('next-step-note')).toBeNull();
  });

  it('keeps the fact that the time has passed, and the estimated-importance tag', async () => {
    await show(1);
    expect(screen.getByText(en.evidenceOverdue)).toBeTruthy();
    expect(screen.getByText(en.nextStepEvidenceEstimated)).toBeTruthy();
  });

  it.each([1.35, 2.0])('keeps the estimated-importance tag at font scale %s', async (scale) => {
    await show(scale);
    expect(screen.getByText(en.nextStepEvidenceEstimated)).toBeTruthy();
  });
});
