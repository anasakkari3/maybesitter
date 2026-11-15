/**
 * An action pressed with no signal (CX3.5, CXX3.1).
 *
 * TanStack Query's default `networkMode: 'online'` paused a mutation started
 * offline: the button sat dimmed with no word said, the action was lost if the
 * app died, and on reconnect it was sent by itself — a capture confirm 63 s
 * later, after the person had left the flow, created the commitment. The app
 * keeps no offline queue on purpose (mobile/AGENTS.md: nothing is persisted,
 * confirm is never retried), so the answer is the other half: the request is
 * tried now, a failure is said now, and nothing is sent later on its own.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, render, renderHook, screen, waitFor, fireEvent } from '@testing-library/react-native';
import { Text } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider, useApp } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../api/auth';
import type { AuthUser } from '../../auth/types';
import { DetailsScreen } from '../DetailsScreen';
import { createAppQueryClient } from '../../api/queryClient';
import { useConfirmCapture } from '../../api/queries';
import { NetworkError } from '../../api/errors';
import type { Commitment } from '../../api/schemas/common';
import en from '../../i18n/locales/en.json';
import * as commitmentEndpoints from '../../api/endpoints/commitments';
import * as captureEndpoints from '../../api/endpoints/capture';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = {
  uid: 'offline-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};
const ID = 'c-offline';
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

/** The line the app's toast host would draw. */
function ToastProbe() {
  const { s } = useApp();
  return s.toast ? <Text testID="probe-toast">{s.toast.text}</Text> : null;
}

function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>
  );
}

beforeEach(() => {
  onlineManager.setOnline(true);
  // The app's own client: its defaults are what is under test.
  client = createAppQueryClient();
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
});

afterEach(() => {
  onlineManager.setOnline(true);
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

describe('Done on Details with no signal (CX3.5)', () => {
  it('is tried now, says it did not go through, and is never sent later on its own', async () => {
    jest.spyOn(commitmentEndpoints, 'getCommitment').mockResolvedValue({ data: commitment(), etag: 'W/"v1"' } as never);
    // What fetch does with no signal: it fails at once.
    const done = jest.spyOn(commitmentEndpoints, 'actOnCommitment').mockRejectedValue(new NetworkError('offline') as never);
    await render(<Providers><OpenDetails /><DetailsScreen /><ToastProbe /></Providers>);
    await waitFor(() => expect(screen.queryByTestId('details-done')).not.toBeNull());

    await act(async () => { onlineManager.setOnline(false); });
    await fireEvent.press(screen.getByTestId('details-done'));

    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId('probe-toast')).not.toBeNull());
    expect(screen.getByTestId('probe-toast').props.children).toBe(en.errorsNetwork);
    // The button is usable again: nothing is left pending.
    expect(screen.getByTestId('details-done').props.accessibilityState).toMatchObject({ disabled: false });

    // The signal returns: nothing is sent without the person.
    await act(async () => { onlineManager.setOnline(true); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(done).toHaveBeenCalledTimes(1);
  });
});

describe('a capture confirm with no signal (CXX3.1)', () => {
  it('fails now rather than waiting, and is never sent on reconnect', async () => {
    const confirm = jest.spyOn(captureEndpoints, 'confirmCapture').mockRejectedValue(new NetworkError('offline') as never);
    const { result } = await renderHook(() => useConfirmCapture(), { wrapper: Providers });
    await act(async () => { onlineManager.setOnline(false); });

    await act(async () => {
      result.current.mutate({ proposalId: 'p-1', itemIds: ['i-1'] } as never);
    });
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.error).toBeInstanceOf(NetworkError));
    expect(result.current.isPaused).toBe(false);

    await act(async () => { onlineManager.setOnline(true); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('the app client never pauses a mutation for the network', () => {
    expect(createAppQueryClient().getDefaultOptions().mutations?.networkMode).toBe('always');
  });
});
