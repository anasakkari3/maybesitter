/**
 * A suggested step put off with «مش هلّق» is remembered for Today's card
 * (QA v3 V3-F11-04), in memory only. Review of #874: it was a query with the
 * default gcTime, so leaving Today for another tab for more than five minutes
 * dropped it, and the fallback card brought the same item back while the
 * server still hid the suggestion. It must outlive an unmounted Today, and
 * still go with the cache on an account change, as everything else does.
 */
import React from 'react';
import { Pressable, Text } from 'react-native';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useQueryClient } from '@tanstack/react-query';
import { AppProvider } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { createAppQueryClient } from '../queryClient';
import { ApiProvider } from '../ui/ApiProvider';
import { recordDeferredNextStep, useDeferredNextSteps, useUid } from '../queries';

const user = (uid: string) => ({ uid, email: `${uid}@example.com`, emailVerified: true, displayName: null, providerIds: ['password'] });

function Probe() {
  const held = useDeferredNextSteps();
  const client = useQueryClient();
  const uid = useUid();
  return <>
    <Text testID="held">{[...held.keys()].join(',') || 'none'}</Text>
    <Pressable testID="put-off" onPress={() => recordDeferredNextStep(client, uid, 'c-1', '2030-01-01T00:00:00.000Z')} />
  </>;
}

afterEach(() => { jest.useRealTimers(); });

describe('a step put off, across Today unmounting and an account change', () => {
  it('outlives Today unmounted for longer than the default cache time', async () => {
    jest.useFakeTimers();
    const repository = createFakeAuthRepository({ initialUser: user('account-a') });
    const client = createAppQueryClient();
    const tree = (shown: boolean) => (
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <ApiProvider client={client}>{shown ? <Probe /> : <Text>another tab</Text>}</ApiProvider>
        </AuthProvider>
      </AppProvider>
    );
    const view = await render(tree(true));
    await fireEvent.press(screen.getByTestId('put-off'));
    await waitFor(() => expect(screen.getByTestId('held')).toHaveTextContent('c-1'));
    await view.rerender(tree(false));
    await act(async () => { jest.advanceTimersByTime(6 * 60 * 1000); });
    await view.rerender(tree(true));
    expect(screen.getByTestId('held')).toHaveTextContent('c-1');
  });

  it('outlives five minutes even when recorded with nothing reading it', async () => {
    jest.useFakeTimers();
    const repository = createFakeAuthRepository({ initialUser: user('account-a') });
    const client = createAppQueryClient();
    recordDeferredNextStep(client, 'account-a', 'c-1', '2030-01-01T00:00:00.000Z');
    await act(async () => { jest.advanceTimersByTime(6 * 60 * 1000); });
    await render(
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <ApiProvider client={client}><Probe /></ApiProvider>
        </AuthProvider>
      </AppProvider>,
    );
    expect(screen.getByTestId('held')).toHaveTextContent('c-1');
  });

  it('another account does not see it, and the first account\'s record and defaults are gone', async () => {
    const repository = createFakeAuthRepository({ initialUser: user('account-a') });
    const client = createAppQueryClient();
    await render(
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <ApiProvider client={client}><Probe /></ApiProvider>
        </AuthProvider>
      </AppProvider>,
    );
    await fireEvent.press(screen.getByTestId('put-off'));
    await waitFor(() => expect(screen.getByTestId('held')).toHaveTextContent('c-1'));
    await act(async () => { repository.emit(null); });
    await act(async () => { repository.emit(user('account-b')); });
    await waitFor(() => expect(screen.getByTestId('held')).toHaveTextContent('none'));
    // Nothing of account A stays in memory: not the record, not a default
    // for its key (review of #874).
    expect(client.getQueryData(['user', 'account-a', 'nextStepDeferred'])).toBeUndefined();
    expect(client.getQueryDefaults(['user', 'account-a', 'nextStepDeferred'])).toEqual({});
  });
});
