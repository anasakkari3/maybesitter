/**
 * The notification prompt after the first timed confirm (first iPhone run, L7).
 *
 * The literal repro: reminders on by server default, the settings switch never
 * touched, so the phone was never asked. Here a confirm that saves a
 * commitment with a time — the real `/api/mobile/capture/confirm` answer from
 * the route exporter — asks once, only when the phone is `undetermined`.
 */
import React, { useEffect } from 'react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, render, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query';
import * as permission from '../permission';
import confirmation from '../../api/__fixtures__/capture.confirmation.json';
import confirmationFailed from '../../api/__fixtures__/capture.confirmationFailed.json';
import { isTimedConfirmation, resetFirstMomentPromptForTests, useNotificationPromptAtFirstMoment } from '../firstMomentPrompt';

const untimed = { ...confirmation, persisted: confirmation.persisted.map(item => ({ ...item, resolvedTime: null })) };

let client: QueryClient;

beforeEach(() => {
  resetFirstMomentPromptForTests();
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  jest.spyOn(permission, 'getNotificationPermission').mockResolvedValue('undetermined');
  jest.spyOn(permission, 'requestNotificationPermission').mockResolvedValue('granted');
});

afterEach(async () => {
  cleanup();
  await new Promise(resolve => setTimeout(resolve, 0));
  client.clear();
  jest.restoreAllMocks();
});

/** A confirm, as the capture flow runs it: a mutation that resolves with the server's answer. */
function Confirms({ answers, wanted = true }: { answers: unknown[]; wanted?: boolean }) {
  useNotificationPromptAtFirstMoment(client, wanted);
  const confirm = useMutation({ mutationFn: async (answer: unknown) => answer });
  useEffect(() => {
    void (async () => {
      for (const answer of answers) await confirm.mutateAsync(answer);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

async function run(answers: unknown[], wanted = true) {
  await render(<QueryClientProvider client={client}><Confirms answers={answers} wanted={wanted} /></QueryClientProvider>);
  // Let every mutation settle and the listener's async read finish.
  await new Promise(resolve => setTimeout(resolve, 20));
}

describe('the first confirmed commitment with a time', () => {
  it('asks the phone, once, when it has never been asked', async () => {
    await run([confirmation, confirmation]);
    await waitFor(() => expect(permission.requestNotificationPermission).toHaveBeenCalledTimes(1));
  });

  it('asks nothing at mount, before any confirm', async () => {
    await run([]);
    expect(permission.requestNotificationPermission).not.toHaveBeenCalled();
    expect(permission.getNotificationPermission).not.toHaveBeenCalled();
  });

  it.each(['granted', 'denied', 'provisional'] as const)('does not ask when the phone already said %s', async (status) => {
    jest.spyOn(permission, 'getNotificationPermission').mockResolvedValue(status);
    await run([confirmation]);
    expect(permission.getNotificationPermission).toHaveBeenCalled();
    expect(permission.requestNotificationPermission).not.toHaveBeenCalled();
  });

  it('waits for a commitment that has a time', async () => {
    await run([untimed, confirmationFailed]);
    expect(permission.requestNotificationPermission).not.toHaveBeenCalled();
    await run([confirmation]);
    await waitFor(() => expect(permission.requestNotificationPermission).toHaveBeenCalledTimes(1));
  });

  it('does not ask an account that turned reminders off', async () => {
    await run([confirmation], false);
    expect(permission.requestNotificationPermission).not.toHaveBeenCalled();
  });
});

describe('recognising a confirm', () => {
  it('reads the real route answers', () => {
    expect(isTimedConfirmation(confirmation)).toBe(true);
    expect(isTimedConfirmation(untimed)).toBe(false);
    expect(isTimedConfirmation(confirmationFailed)).toBe(false);
    expect(isTimedConfirmation({ success: true })).toBe(false);
  });
});

describe('where it runs', () => {
  it('is mounted for the whole signed-in session, by RemindersMount', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'features', 'reminders', 'RemindersMount.tsx'), 'utf8');
    expect(source).toMatch(/useNotificationPromptAtFirstMoment\(queryClient,/);
  });
});
