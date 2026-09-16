/**
 * Accepting a plan leaves the week out of date (UC-3.15 #201, UC-3.10a #194).
 *
 * An accepted plan is now a day with a plan and, the first time, a Moment. The
 * plan actions already invalidated the history; the week's summary is a
 * separate key, and a screen that kept the old one would say "no days with a
 * plan" right after the person accepted one.
 */
import React from 'react';
import { Pressable, Text } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { queryKeys, usePlanAction } from '../../../api/queries';
import * as planEndpoints from '../../../api/endpoints/plans';
import acceptedFixture from '../../../api/__fixtures__/plan.accepted.json';

const USER: AuthUser = {
  uid: 'plan-fresh-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(planEndpoints, 'actOnPlan').mockResolvedValue(acceptedFixture as never);
});

afterEach(() => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

function Accept() {
  const action = usePlanAction('2026-09-14');
  return (
    <Pressable testID="accept" onPress={() => action.mutate('accept')}>
      <Text>{action.isSuccess ? 'done' : 'accept'}</Text>
    </Pressable>
  );
}

describe('accepting a plan', () => {
  it('invalidates the history and the week, for this account only', async () => {
    const invalidate = jest.spyOn(client, 'invalidateQueries');
    await render(
      <AuthProvider repository={repository} isDevBundle={false}>
        <QueryClientProvider client={client}><Accept /></QueryClientProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.queryByText('accept')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('accept'));
    await waitFor(() => expect(screen.queryByText('done')).not.toBeNull());

    const keys = invalidate.mock.calls.map(([filters]) => JSON.stringify((filters as { queryKey?: unknown }).queryKey));
    expect(keys).toContain(JSON.stringify(queryKeys.activity(USER.uid)));
    expect(keys).toContain(JSON.stringify(['user', USER.uid, 'activitySummary']));
  });
});
