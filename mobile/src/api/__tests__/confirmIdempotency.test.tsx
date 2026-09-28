/**
 * One idempotency key per confirm *intent*, not per press.
 *
 * The owner's repro: a confirm that the server committed, but whose answer
 * never reached the phone (a client timeout), was pressed again. A fresh key on
 * the second press made it a different request to the server, which found the
 * proposal already confirmed under the first key and refused it — so a save
 * that had worked was reported as a failure.
 *
 * The key is the same while the proposal, the selection and the edits are the
 * same, and changes when any of them does: a corrected title is a new intent
 * and must not be answered with the first one's replay (#164).
 */
import React from 'react';
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useConfirmCapture } from '../queries';
import * as captureEndpoints from '../endpoints/capture';
import { TimeoutError } from '../errors';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { AuthProvider } from '../../auth/AuthProvider';
import { resetAuthForTests, setAuthRepository } from '../auth';
import confirmation from '../__fixtures__/capture.confirmation.json';

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({
    initialUser: { uid: 'alice', email: null, emailVerified: true, displayName: null, providerIds: ['password'] },
  });
  setAuthRepository(repository);
});

afterEach(() => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider repository={repository} isDevBundle={false}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </AuthProvider>
  );
}

it('retries a timed-out confirm with the key the first press used', async () => {
  const confirm = jest.spyOn(captureEndpoints, 'confirmCapture')
    .mockRejectedValueOnce(new TimeoutError('no answer in 15 s'))
    .mockResolvedValueOnce(confirmation as never);
  const { result } = await renderHook(() => useConfirmCapture(), { wrapper });
  const input = { proposalId: 'p1', itemIds: ['b', 'a'] };

  await act(async () => { await result.current.mutateAsync(input).catch(() => undefined); });
  await act(async () => { await result.current.mutateAsync({ proposalId: 'p1', itemIds: ['a', 'b'] }); });

  const [first, second] = confirm.mock.calls.map(([call]) => call.idempotencyKey);
  expect(first).toEqual(expect.any(String));
  expect(second).toBe(first);
});

it('mints a new key when the selection or an edit changes', async () => {
  const confirm = jest.spyOn(captureEndpoints, 'confirmCapture').mockResolvedValue(confirmation as never);
  const { result } = await renderHook(() => useConfirmCapture(), { wrapper });

  await act(async () => { await result.current.mutateAsync({ proposalId: 'p1', itemIds: ['a'] }); });
  await act(async () => { await result.current.mutateAsync({ proposalId: 'p1', itemIds: ['a', 'b'] }); });
  await act(async () => {
    await result.current.mutateAsync({ proposalId: 'p1', itemIds: ['a', 'b'], edits: [{ itemId: 'a', title: 'Call Dana' }] });
  });
  await act(async () => { await result.current.mutateAsync({ proposalId: 'p2', itemIds: ['a'] }); });

  const keys = confirm.mock.calls.map(([call]) => call.idempotencyKey);
  expect(new Set(keys).size).toBe(4);
});
