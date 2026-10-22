/**
 * M5b-2b-1 (APP-REV-005): every app operation that can create, supersede or
 * delete memory bumps the memory revision — the signal every holder of
 * intelligence suggestions rereads on — and reads the memory list again: on
 * success, and on a failure that may have committed (a timeout, a 5xx). A
 * failure that proves the server refused the write changes nothing.
 */
import React from 'react';
import { Pressable } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as profileEndpoints from '../endpoints/profile';
import { TimeoutError, ValidationError } from '../errors';
import {
  memoryRevisionOf,
  useConfirmAiContextImport,
  useConfirmProfileSuggestions,
  usePutRoutine,
} from '../queries';
import { ACCOUNT_A, NOW, Providers, initialState, prepare, teardown, type M5bHarness } from '../../__acceptance__/m5b/harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

let harness: M5bHarness | undefined;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(async () => {
  await teardown(harness);
  harness = undefined;
  jest.useRealTimers();
});

function Writers() {
  const routine = usePutRoutine();
  const importConfirm = useConfirmAiContextImport();
  const describeConfirm = useConfirmProfileSuggestions();
  return <>
    <Pressable testID="routine" onPress={() => routine.mutate({} as never)} />
    <Pressable testID="import" onPress={() => importConfirm.mutate({ proposalId: 'p1', accepted: [{ index: 0 }] })} />
    <Pressable testID="describe" onPress={() => describeConfirm.mutate({ proposalId: 'p2', accepted: [{ index: 0 }] })} />
  </>;
}

async function mount(): Promise<M5bHarness> {
  harness = await prepare('en', initialState());
  await render(<Providers harness={harness}><Writers /></Providers>);
  return harness;
}

async function pressAndSettle(testID: string, call: { mock: { calls: unknown[] } }): Promise<void> {
  await fireEvent.press(screen.getByTestId(testID));
  await waitFor(() => expect(call.mock.calls.length).toBe(1));
  // Past the mutation's settle callbacks.
  await waitFor(() => expect(harness!.client.isMutating()).toBe(0));
}

describe('APP-REV-005 memory writers settle through the revision', () => {
  it('APP-REV-005 the AI context import confirmation bumps the revision and rereads the memory list', async () => {
    const confirm = jest.spyOn(profileEndpoints, 'confirmAiContextImport').mockResolvedValue({ success: true } as never);
    const h = await mount();
    const invalidate = jest.spyOn(h.client, 'invalidateQueries');
    const before = memoryRevisionOf(ACCOUNT_A.uid);
    await pressAndSettle('import', confirm);
    expect(memoryRevisionOf(ACCOUNT_A.uid)).toBe(before + 1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['user', ACCOUNT_A.uid, 'memory'] });
  });

  it('APP-REV-005 the describe-yourself confirmation bumps the revision and rereads the memory list', async () => {
    const confirm = jest.spyOn(profileEndpoints, 'confirmProfileSuggestions').mockResolvedValue({ success: true } as never);
    const h = await mount();
    const invalidate = jest.spyOn(h.client, 'invalidateQueries');
    const before = memoryRevisionOf(ACCOUNT_A.uid);
    await pressAndSettle('describe', confirm);
    expect(memoryRevisionOf(ACCOUNT_A.uid)).toBe(before + 1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['user', ACCOUNT_A.uid, 'memory'] });
  });

  it('APP-REV-005 a routine save that timed out (it may have committed) bumps the revision', async () => {
    const put = jest.spyOn(profileEndpoints, 'putRoutine').mockRejectedValue(new TimeoutError('the request timed out'));
    await mount();
    const before = memoryRevisionOf(ACCOUNT_A.uid);
    await pressAndSettle('routine', put);
    expect(memoryRevisionOf(ACCOUNT_A.uid)).toBe(before + 1);
  });

  it('APP-REV-005 a routine save the server refused changes nothing and bumps nothing', async () => {
    const put = jest.spyOn(profileEndpoints, 'putRoutine').mockRejectedValue(new ValidationError('invalid'));
    await mount();
    const before = memoryRevisionOf(ACCOUNT_A.uid);
    await pressAndSettle('routine', put);
    expect(memoryRevisionOf(ACCOUNT_A.uid)).toBe(before);
  });
});
