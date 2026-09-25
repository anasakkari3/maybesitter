/**
 * The screens the trust surface is made of (UC-2.R4 #174, memory from #167).
 *
 * Three claims are load-bearing and each has a test that fails if it stops
 * being true:
 *
 *  - what-knows never prints a "never" promise the server contradicts;
 *  - the memory section disappears when the feature is off, rather than
 *    showing an empty state that implies a store;
 *  - no screen here sends the retired pilot `delete` action.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { KnowsScreen } from '../KnowsScreen';
import { TrustScreen } from '../TrustScreen';
import { RoutineSettingsScreen } from '../RoutineSettingsScreen';
import { FeedbackHistoryScreen } from '../FeedbackHistoryScreen';
import en from '../../../i18n/locales/en.json';
import trustFixture from '../../../api/__fixtures__/trust.state.json';

import * as trustEndpoints from '../../../api/endpoints/trust';
import * as profileEndpoints from '../../../api/endpoints/profile';
import * as feedbackEndpoints from '../../../api/endpoints/feedback';
import * as accountExportEndpoints from '../../../api/endpoints/accountExport';
import { InputTooLargeError } from '../../../api/errors';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const USER: AuthUser = {
  uid: 'settings-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

function trustWith(knows: Partial<typeof trustFixture.whatKnows>) {
  return { ...trustFixture, whatKnows: { ...trustFixture.whatKnows, ...knows } };
}

beforeEach(() => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue(trustFixture as never);
  // 404: the memory feature is off, which is the default everywhere today.
  jest.spyOn(profileEndpoints, 'listMemory').mockRejectedValue(new Error('not found'));
  jest.spyOn(feedbackEndpoints, 'getFeedbackHistory').mockResolvedValue({ version: 'v1', rows: [] } as never);
});

afterEach(async () => {
  cleanup();
  // A real macrotask, not a microtask flush. A save still settling when the
  // tree came down leaves React work in flight, and in RNTL v14 the *next*
  // test's `render` then mounts nothing at all — a failure that looks like a
  // missing element rather than like the leak it is.
  await new Promise(resolve => setTimeout(resolve, 0));
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
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

it('offers the pilot report from Trust and sends no free-text content', async () => {
  const report = jest.spyOn(trustEndpoints, 'reportPilotIncident').mockResolvedValue({ success: true, incidentId: 'incident-test', status: 'open' });
  await show(<TrustScreen onBack={() => {}} onKnows={() => {}} />);
  await waitFor(() => expect(screen.queryByTestId('trust-report-open')).not.toBeNull());
  await fireEvent.press(screen.getByTestId('trust-report-open'));
  await fireEvent.press(screen.getByTestId('trust-report-submit'));
  await waitFor(() => expect(report).toHaveBeenCalledWith({ surface: 'capture', category: 'reliability' }));
  await waitFor(() => expect(screen.queryByTestId('trust-report-saved')).not.toBeNull());
});

it('Trust offers the real export, and says so when the account is too large for it', async () => {
  const exported = jest.spyOn(accountExportEndpoints, 'getAccountExport').mockRejectedValue(new InputTooLargeError(0));
  await show(<TrustScreen onBack={() => {}} onKnows={() => {}} />);
  await waitFor(() => expect(screen.queryByTestId('trust-export')).not.toBeNull());
  // The "not available yet" placeholder is gone with the endpoint shipped.
  expect(screen.queryByTestId('trust-export-unavailable')).toBeNull();
  await fireEvent.press(screen.getByTestId('trust-export'));
  await waitFor(() => expect(screen.queryByTestId('trust-export-failed')).not.toBeNull());
  expect(exported).toHaveBeenCalledTimes(1);
  expect(screen.getByText(en.exportDataTooLarge)).toBeTruthy();
});

describe('what MaybeSitter knows', () => {
  it('shows the confirmed commitment count the server reported', async () => {
    await show(<KnowsScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('knows-commitment-count')).not.toBeNull());
    expect(screen.getByTestId('knows-commitment-count').props.children)
      .toBe(String(trustFixture.whatKnows.confirmedCommitmentCount));
  });

  it('prints the three "never" promises while the server agrees', async () => {
    jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue(trustWith({
      privateMessageIngestion: false, sensitiveInference: false, medicalProfile: false,
    }) as never);
    await show(<KnowsScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('knows-never')).not.toBeNull());
    for (const key of ['messages', 'inference', 'medical']) {
      expect(screen.queryByTestId(`knows-never-${key}`)).not.toBeNull();
    }
  });

  it('drops the promise the server contradicts, and keeps the rest', async () => {
    // Static copy about somebody's privacy is exactly the kind that goes on
    // being displayed after it stops being true.
    jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue(trustWith({
      privateMessageIngestion: true, sensitiveInference: false, medicalProfile: false,
    }) as never);
    await show(<KnowsScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('knows-never')).not.toBeNull());
    expect(screen.queryByTestId('knows-never-messages')).toBeNull();
    expect(screen.queryByTestId('knows-never-inference')).not.toBeNull();
  });

  it('prints no promise at all while the server has not answered', async () => {
    jest.spyOn(trustEndpoints, 'getTrust').mockImplementation(() => new Promise(() => {}) as never);
    await show(<KnowsScreen onBack={() => {}} />);
    expect(screen.queryByTestId('knows-never')).toBeNull();
    expect(screen.queryByText(en.knowsNeverMessages)).toBeNull();
  });
});

describe('the memory section', () => {
  it('is absent entirely when the feature is off', async () => {
    // Not an empty state: a build without the feature has no memory, and
    // "nothing yet" would imply a store that happens to be empty.
    await show(<KnowsScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('knows-commitment-count')).not.toBeNull());
    expect(screen.queryByTestId('memory-section')).toBeNull();
    expect(screen.queryByTestId('memory-empty')).toBeNull();
  });

  it('appears, with its rows, when the feature is on', async () => {
    jest.spyOn(profileEndpoints, 'listMemory').mockResolvedValue({
      items: [{
        id: 'mem_1', kind: 'preference', content: 'quiet_hours:22:30-07:30', language: 'mixed',
        source: 'user_stated', confidence: 1,
        createdAt: '2026-09-13T09:00:00.000Z', observedAt: '2026-09-13T09:00:00.000Z',
        provenance: { origin: 'routine_survey', originRef: 'routine-survey-v1' },
      }],
    } as never);
    await show(<KnowsScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('memory-section')).not.toBeNull());
    expect(screen.queryByTestId('memory-item-mem_1')).not.toBeNull();
    expect(screen.getByTestId('memory-chip-mem_1').props.children).toBe(en.memoryFromSurvey);
  });
});

describe('feedback history', () => {
  it('says it is unreachable rather than showing a generic error', async () => {
    jest.spyOn(feedbackEndpoints, 'getFeedbackHistory').mockRejectedValue(new Error('503'));
    await show(<FeedbackHistoryScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('feedback-history-unavailable')).not.toBeNull());
    expect(screen.getByText(en.feedbackHistoryUnavailable)).toBeTruthy();
  });

  it('offers revoke only for a row that may be revoked', async () => {
    jest.spyOn(feedbackEndpoints, 'getFeedbackHistory').mockResolvedValue({
      version: 'v1',
      rows: [
        { id: 'a', outcome: 'accept', subjectId: 's1', occurredAt: '2026-09-13T09:00:00.000Z', revokedAt: null, canRevoke: true },
        { id: 'b', outcome: 'ignore', subjectId: 's2', occurredAt: '2026-09-13T09:00:00.000Z', revokedAt: null, canRevoke: false },
      ],
    } as never);
    await show(<FeedbackHistoryScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('feedback-row-a')).not.toBeNull());
    expect(screen.queryByTestId('feedback-revoke-a')).not.toBeNull();
    expect(screen.queryByTestId('feedback-revoke-b')).toBeNull();
  });

  it('keeps a revoked row, marked, rather than removing it', async () => {
    // The row is the visible evidence the correction was applied. Dropping it
    // asks the user to take our word for it, on the screen that exists
    // because they might not.
    jest.spyOn(feedbackEndpoints, 'getFeedbackHistory').mockResolvedValue({
      version: 'v1',
      rows: [{ id: 'a', outcome: 'accept', subjectId: 's1', occurredAt: '2026-09-13T09:00:00.000Z', revokedAt: '2026-09-14T09:00:00.000Z', canRevoke: false }],
    } as never);
    await show(<FeedbackHistoryScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('feedback-row-a')).not.toBeNull());
    expect(screen.queryByTestId('feedback-revoked-a')).not.toBeNull();
  });

  it('has its own empty state', async () => {
    await show(<FeedbackHistoryScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('feedback-history-empty')).not.toBeNull());
  });
});

describe('the retired pilot delete action', () => {
  it('is sent by no screen in the app', () => {
    // UC-1.5 (#149) retired it — the route answers 400 `use_account_deletion`.
    // Deleting an account goes through the real flow, and this asserts the old
    // one cannot creep back in through a settings screen.
    const roots = [join(__dirname, '..', '..'), join(__dirname, '..', '..', '..', 'screens')];
    const offenders: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) { walk(path); continue; }
        if (!entry.name.endsWith('.tsx') && !entry.name.endsWith('.ts')) continue;
        if (entry.name.includes('.test.')) continue;
        // Comments are stripped first: a file that *explains* why it does not
        // send the action would otherwise fail its own check.
        const source = readFileSync(path, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/[^\n]*/g, '');
        if (/type:\s*['"]delete['"]/.test(source)) offenders.push(path);
      }
    };
    for (const root of roots) walk(root);
    expect(offenders).toEqual([]);
  });
});

describe('the answers you gave to next steps (#170, #174)', () => {
  /**
   * Listed beside the behaviour log, not merged into it.
   *
   * A behaviour row is an observation the system made and offers to revoke; a
   * decision is a choice the person made and there is nothing to correct.
   * Listing them under one heading would tell somebody their own decision was
   * something we inferred about them.
   */
  const decision = (over: Record<string, unknown> = {}) => ({
    proposalId: 'p-1',
    commitmentId: 'c-1',
    decision: 'defer',
    at: '2026-09-13T09:00:00.000Z',
    deferUntil: '2026-09-13T10:00:00.000Z',
    ...over,
  });

  it('lists them in words, not as enum values', async () => {
    jest.spyOn(feedbackEndpoints, 'getFeedbackHistory').mockResolvedValue({
      version: 'v1', rows: [], nextStepDecisions: [decision()],
    } as never);
    await show(<FeedbackHistoryScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('history-decisions')).not.toBeNull());
    // Isolated with U+2066/U+2069, like the outcome rows above it, so a Latin
    // fragment cannot reverse inside an Arabic line.
    expect(screen.queryByText(`\u2066${en.historyDecisionDefer}\u2069`)).not.toBeNull();
    expect(screen.queryByText('defer')).toBeNull();
  });

  it('keeps them out of the behaviour rows', async () => {
    jest.spyOn(feedbackEndpoints, 'getFeedbackHistory').mockResolvedValue({
      version: 'v1', rows: [], nextStepDecisions: [decision()],
    } as never);
    await show(<FeedbackHistoryScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('history-decisions')).not.toBeNull());
    // The behaviour log is genuinely empty and still says so.
    expect(screen.queryByTestId('feedback-history-empty')).not.toBeNull();
  });

  it('says the section is empty rather than hiding it', async () => {
    jest.spyOn(feedbackEndpoints, 'getFeedbackHistory').mockResolvedValue({
      version: 'v1', rows: [],
    } as never);
    await show(<FeedbackHistoryScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('history-decisions-empty')).not.toBeNull());
  });

  it('skips an answer this build has no words for', async () => {
    // A server that learns a sixth decision must not put its enum on screen.
    jest.spyOn(feedbackEndpoints, 'getFeedbackHistory').mockResolvedValue({
      version: 'v1', rows: [], nextStepDecisions: [decision({ decision: 'snoozed_forever' })],
    } as never);
    await show(<FeedbackHistoryScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('history-decisions')).not.toBeNull());
    expect(screen.queryByText('snoozed_forever')).toBeNull();
  });

  it('shows nothing at all when the whole history is unavailable', async () => {
    jest.spyOn(feedbackEndpoints, 'getFeedbackHistory').mockRejectedValue(new Error('503'));
    await show(<FeedbackHistoryScreen onBack={() => {}} />);
    await waitFor(() => expect(screen.queryByTestId('feedback-history-unavailable')).not.toBeNull());
    expect(screen.queryByTestId('history-decisions-empty')).toBeNull();
  });
});

/**
 * What the routine screen may claim after a save (UC-2.R4 #174, #167 step 5).
 *
 * `saveRoutineCache` reports a disk that refused the write, and this screen
 * used to discard that boolean — so a phone that had stored nothing, for an
 * account that had also not stored it, still read "saved on this phone".
 */
describe('saving the routine survey', () => {
  beforeEach(() => {
    jest.spyOn(profileEndpoints, 'getProfile').mockResolvedValue({ routine: null } as never);
  });

  it('does not claim the phone kept answers the phone refused', async () => {
    jest.spyOn(profileEndpoints, 'putRoutine').mockRejectedValue(new Error('no signal'));
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValue(new Error('no space'));

    await show(<RoutineSettingsScreen onBack={() => {}} />);
    await fireEvent.press(screen.getByTestId('routine-settings-save'));

    await waitFor(() => expect(screen.queryByTestId('routine-settings-lost')).not.toBeNull());
    expect(screen.queryByText(en.obRoutineSaveLost)).not.toBeNull();
    // The line that would have been shown, and would have been false.
    expect(screen.queryByTestId('routine-settings-failed')).toBeNull();
  });

  it('still says the phone has them when only the account write failed', async () => {
    jest.spyOn(profileEndpoints, 'putRoutine').mockRejectedValue(new Error('no signal'));
    // Stated rather than assumed: `AsyncStorage` is a module mock already, and
    // a spy laid over one of its methods is not reliably put back by
    // `restoreAllMocks`, so the disk this test needs is the one it asks for.
    jest.spyOn(AsyncStorage, 'setItem').mockResolvedValue(undefined);

    await show(<RoutineSettingsScreen onBack={() => {}} />);
    await fireEvent.press(screen.getByTestId('routine-settings-save'));

    await waitFor(() => expect(screen.queryByTestId('routine-settings-failed')).not.toBeNull());
    expect(screen.queryByTestId('routine-settings-lost')).toBeNull();
  });
});
