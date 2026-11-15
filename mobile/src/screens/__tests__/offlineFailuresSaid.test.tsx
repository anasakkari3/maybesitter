/**
 * Every press that fails with no signal says so (review of lane A3).
 *
 * `networkMode: 'always'` stopped mutations from being paused and replayed
 * later without the person (CX3.5, CXX3.1). It also meant a press offline
 * failed at once — and on several surfaces that failure was never read, so
 * "silently queued" became "silently did nothing". Two guarantees close that:
 *
 *  - `MutationFailureToasts` says, once, any network-class failure no screen
 *    put into words itself (a screen that does goes through
 *    `userFacingMessage`, which marks the error as said, so nothing is said
 *    twice); a background write opts out with `meta: { quietFailure: true }`;
 *  - the surfaces where the person typed something — the edit sheet, the
 *    next-step editor — keep it and say the failure in place.
 */
import React from 'react';
import { Pressable, Text } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClientProvider, onlineManager, useMutation } from '@tanstack/react-query';
import { AppProvider, useApp } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../api/auth';
import type { AuthUser } from '../../auth/types';
import { DetailsScreen } from '../DetailsScreen';
import { SheetHost } from '../Sheets';
import { NextStepCard } from '../../features/nextStep/NextStepCard';
import { createAppQueryClient } from '../../api/queryClient';
import { NetworkError } from '../../api/errors';
import { MutationFailureToasts, UNHANDLED_FAILURE_DELAY_MS } from '../../api/ui/MutationFailureToasts';
import type { Commitment } from '../../api/schemas/common';
import en from '../../i18n/locales/en.json';
import * as commitmentEndpoints from '../../api/endpoints/commitments';
import * as nextStepEndpoints from '../../api/endpoints/nextStep';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = {
  uid: 'offline-said-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};
const ID = 'c-said';
const SOON = new Date(Date.now() + 3 * 24 * 3600_000).toISOString();

function commitment(): Commitment {
  return {
    id: ID, kind: 'task', title: 'Hand in the project report', description: null, person: null, status: 'active',
    priority: { level: 'high', source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' },
    timeSpec: { kind: 'due_by', dueAt: SOON, remindAt: null, timezone: 'Asia/Jerusalem' },
    currentAckState: 'not_seen', postponedUntil: null,
    createdAt: '2026-09-01T09:00:00.000Z', updatedAt: '2026-09-01T09:00:00.000Z', confirmedAt: '2026-09-01T09:00:00.000Z',
    completedAt: null, droppedAt: null,
  } as Commitment;
}

let client: ReturnType<typeof createAppQueryClient>;
let repository: ReturnType<typeof createFakeAuthRepository>;
let toasts: string[];

function OpenDetails() {
  const { actions } = useApp();
  const opened = React.useRef(false);
  React.useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    actions.openDetail(ID);
  }, [actions]);
  return null;
}

/** Every line the toast host would have drawn, in order. */
function ToastLog() {
  const { s } = useApp();
  React.useEffect(() => { if (s.toast) toasts.push(s.toast.text); }, [s.toast]);
  return null;
}

async function show(node: React.ReactNode) {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}>{node}<MutationFailureToasts /><ToastLog /></QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

/** Long enough for the bridge to have said whatever it was going to say. */
async function settle() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, UNHANDLED_FAILURE_DELAY_MS + 100)); });
}

beforeEach(() => {
  onlineManager.setOnline(true);
  client = createAppQueryClient();
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  toasts = [];
  jest.spyOn(commitmentEndpoints, 'getCommitment').mockResolvedValue({ data: commitment(), etag: 'W/"v1"' } as never);
});

afterEach(() => {
  onlineManager.setOnline(true);
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

describe('the bridge says an unhandled offline failure, once', () => {
  function Harness({ quiet = false }: { quiet?: boolean }) {
    const write = useMutation({
      mutationFn: async () => { throw new NetworkError('offline'); },
      ...(quiet ? { meta: { quietFailure: true } } : {}),
    });
    return <Pressable testID="harness-write" onPress={() => write.mutate()}><Text>write</Text></Pressable>;
  }

  it('a press nobody answers is said as a toast', async () => {
    await show(<Harness />);
    await act(async () => { onlineManager.setOnline(false); });
    await fireEvent.press(screen.getByTestId('harness-write'));
    await waitFor(() => expect(toasts).toEqual([en.errorsNetwork]));
  });

  it('a background write that opted out is not said', async () => {
    await show(<Harness quiet />);
    await act(async () => { onlineManager.setOnline(false); });
    await fireEvent.press(screen.getByTestId('harness-write'));
    await settle();
    expect(toasts).toEqual([]);
  });
});

describe('the edit sheet, offline', () => {
  it('keeps the sheet and the typed title, says why, and says it once', async () => {
    jest.spyOn(commitmentEndpoints, 'patchCommitment').mockRejectedValue(new NetworkError('offline') as never);
    await show(<><OpenDetails /><DetailsScreen /><SheetHost /></>);
    await waitFor(() => expect(screen.queryByTestId('details-edit')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('details-edit'));
    await waitFor(() => expect(screen.queryByTestId('edit-title')).not.toBeNull());
    await act(async () => { onlineManager.setOnline(false); });

    await fireEvent.changeText(screen.getByTestId('edit-title'), 'Hand it in on Monday');
    await fireEvent.press(screen.getByTestId('edit-save'));

    await waitFor(() => expect(screen.queryByTestId('edit-error')).not.toBeNull());
    expect(screen.getByTestId('edit-error').props.children).toBe(en.errorsNetwork);
    expect(screen.getByTestId('edit-title').props.value).toBe('Hand it in on Monday');
    await settle();
    expect(toasts).toEqual([]);
  });
});

describe('drop and delete, offline', () => {
  it.each<[string, string, string]>([
    ['drop', 'details-drop', 'confirm-drop'],
    ['delete', 'details-delete', 'confirm-delete'],
  ])('%s keeps the dialog open and says it did not go through', async (_intent, open, confirm) => {
    jest.spyOn(commitmentEndpoints, 'actOnCommitment').mockRejectedValue(new NetworkError('offline') as never);
    jest.spyOn(commitmentEndpoints, 'deleteCommitment').mockRejectedValue(new NetworkError('offline') as never);
    await show(<><OpenDetails /><DetailsScreen /><SheetHost /></>);
    await waitFor(() => expect(screen.queryByTestId(open)).not.toBeNull());
    await fireEvent.press(screen.getByTestId(open));
    await waitFor(() => expect(screen.queryByTestId(confirm)).not.toBeNull());
    await act(async () => { onlineManager.setOnline(false); });
    await fireEvent.press(screen.getByTestId(confirm));

    await waitFor(() => expect(screen.queryByTestId('confirm-error')).not.toBeNull());
    expect(screen.getByTestId('confirm-error').props.children).toBe(en.errorsNetwork);
    expect(screen.queryByTestId(confirm)).not.toBeNull();
    await settle();
    expect(toasts).toEqual([]);
  });
});

describe('the next-step editor, offline', () => {
  it('keeps the editor and the typed title, and says why', async () => {
    jest.spyOn(nextStepEndpoints, 'getNextStep').mockResolvedValue({
      success: true, participantId: USER.uid,
      recommendation: {
        version: 'v1', proposalId: 'p-1', state: 'ready', locale: 'en',
        primaryStep: { commitmentId: 'c-1', title: 'Send the report to Sami' },
        explanation: { summary: 'x', evidenceLabels: [], evidenceCodes: [], sensitiveInferenceUsed: false },
        availableActions: ['accept', 'edit', 'defer', 'dismiss', 'done'],
        persistence: { occurred: false, confirmationRequired: true },
      },
    } as never);
    jest.spyOn(nextStepEndpoints, 'recordNextStepDecision').mockRejectedValue(new NetworkError('offline') as never);
    await show(<NextStepCard />);
    await waitFor(() => expect(screen.queryByTestId('next-step-more')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('next-step-more'));
    await fireEvent.press(screen.getByTestId('next-step-edit'));
    await waitFor(() => expect(screen.queryByTestId('next-step-edit-input')).not.toBeNull());
    await act(async () => { onlineManager.setOnline(false); });

    await fireEvent.changeText(screen.getByTestId('next-step-edit-input'), 'Send Sami the short version');
    await fireEvent.press(screen.getByTestId('next-step-edit-save'));

    await waitFor(() => expect(screen.queryByTestId('next-step-failed')).not.toBeNull());
    expect(screen.getByTestId('next-step-failed').props.children).toBe(en.errorsNetwork);
    expect(screen.getByTestId('next-step-edit-input').props.value).toBe('Send Sami the short version');
    await settle();
    expect(toasts).toEqual([]);
  });
});
